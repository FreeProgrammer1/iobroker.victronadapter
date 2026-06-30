'use strict';

const net = require('node:net');
const timers = require('node:timers');

class ModbusError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'ModbusError';
        this.code = code;
    }
}

class ModbusTcpClient {
    constructor(options = {}) {
        this.host = options.host;
        this.port = Number(options.port || 502);
        this.timeout = Number(options.timeout || 3000);
        this.logger = options.logger || console;
        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.transactionId = 1;
        this.pending = new Map();
        this.connecting = null;
        this.connected = false;
        this.destroyed = false;
    }

    updateOptions(options = {}) {
        const hostChanged = options.host && options.host !== this.host;
        const portChanged = options.port && Number(options.port) !== this.port;
        const timeoutChanged = options.timeout && Number(options.timeout) !== this.timeout;

        this.host = options.host || this.host;
        this.port = Number(options.port || this.port || 502);
        this.timeout = Number(options.timeout || this.timeout || 3000);

        if (hostChanged || portChanged || timeoutChanged) {
            this.close();
        }
    }

    async connect() {
        if (this.destroyed) {
            throw new Error('Modbus client is destroyed');
        }
        if (this.socket && this.connected) {
            return;
        }
        if (this.connecting) {
            return this.connecting;
        }

        this.connecting = new Promise((resolve, reject) => {
            const socket = new net.Socket();
            let finished = false;
            const timer = timers.setTimeout(() => {
                finish(new Error(`Connection timeout to ${this.host}:${this.port}`));
                socket.destroy();
            }, this.timeout);

            const finish = (err) => {
                if (finished) return;
                finished = true;
                timers.clearTimeout(timer);
                socket.removeListener('connect', onConnect);
                socket.removeListener('error', onErrorDuringConnect);
                if (err) reject(err);
                else resolve();
            };

            const onConnect = () => {
                this.socket = socket;
                this.connected = true;
                this.buffer = Buffer.alloc(0);
                socket.setKeepAlive(true, 30000);
                socket.on('data', data => this._onData(data));
                socket.on('error', err => this._onSocketError(err));
                socket.on('close', () => this._onSocketClose());
                finish();
            };

            const onErrorDuringConnect = (err) => finish(err);

            socket.once('connect', onConnect);
            socket.once('error', onErrorDuringConnect);
            socket.connect(this.port, this.host);
        }).finally(() => {
            this.connecting = null;
        });

        return this.connecting;
    }

    close() {
        if (this.socket) {
            this.socket.destroy();
        }
        this.socket = null;
        this.connected = false;
        this.buffer = Buffer.alloc(0);
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Modbus connection closed'));
        }
        this.pending.clear();
    }

    destroy() {
        this.destroyed = true;
        this.close();
    }

    async readHoldingRegisters(unitId, address, quantity) {
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 125) {
            throw new Error(`Invalid quantity ${quantity}`);
        }
        const pdu = Buffer.alloc(5);
        pdu.writeUInt8(3, 0);
        pdu.writeUInt16BE(address, 1);
        pdu.writeUInt16BE(quantity, 3);
        const response = await this._request(unitId, pdu);
        const functionCode = response.readUInt8(0);
        if (functionCode !== 3) {
            throw new ModbusError(`Unexpected function code ${functionCode}`, functionCode);
        }
        const byteCount = response.readUInt8(1);
        if (byteCount !== quantity * 2) {
            throw new ModbusError(`Unexpected byte count ${byteCount}`, 'BAD_BYTE_COUNT');
        }
        const registers = [];
        for (let i = 0; i < quantity; i++) {
            registers.push(response.readUInt16BE(2 + i * 2));
        }
        return registers;
    }

    async writeSingleRegister(unitId, address, value) {
        const pdu = Buffer.alloc(5);
        pdu.writeUInt8(6, 0);
        pdu.writeUInt16BE(address, 1);
        pdu.writeUInt16BE(value & 0xffff, 3);
        const response = await this._request(unitId, pdu);
        const functionCode = response.readUInt8(0);
        if (functionCode !== 6) {
            throw new ModbusError(`Unexpected function code ${functionCode}`, functionCode);
        }
        return true;
    }

    async writeMultipleRegisters(unitId, address, values) {
        if (!Array.isArray(values) || values.length < 1 || values.length > 123) {
            throw new Error('Invalid write register array');
        }
        const pdu = Buffer.alloc(6 + values.length * 2);
        pdu.writeUInt8(16, 0);
        pdu.writeUInt16BE(address, 1);
        pdu.writeUInt16BE(values.length, 3);
        pdu.writeUInt8(values.length * 2, 5);
        values.forEach((value, index) => pdu.writeUInt16BE(value & 0xffff, 6 + index * 2));
        const response = await this._request(unitId, pdu);
        const functionCode = response.readUInt8(0);
        if (functionCode !== 16) {
            throw new ModbusError(`Unexpected function code ${functionCode}`, functionCode);
        }
        return true;
    }

    async _request(unitId, pdu) {
        await this.connect();
        const id = this.transactionId;
        this.transactionId = (this.transactionId % 0xffff) + 1;

        const header = Buffer.alloc(7);
        header.writeUInt16BE(id, 0);
        header.writeUInt16BE(0, 2);
        header.writeUInt16BE(pdu.length + 1, 4);
        header.writeUInt8(unitId & 0xff, 6);
        const frame = Buffer.concat([header, pdu]);

        return new Promise((resolve, reject) => {
            const timer = timers.setTimeout(() => {
                this.pending.delete(id);
                this.close();
                reject(new ModbusError(`Timeout waiting for Modbus response transaction ${id}`, 'TIMEOUT'));
            }, this.timeout);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.write(frame, err => {
                if (err) {
                    timers.clearTimeout(timer);
                    this.pending.delete(id);
                    reject(err);
                }
            });
        });
    }

    _onData(data) {
        this.buffer = Buffer.concat([this.buffer, data]);

        while (this.buffer.length >= 7) {
            const transactionId = this.buffer.readUInt16BE(0);
            const protocolId = this.buffer.readUInt16BE(2);
            const length = this.buffer.readUInt16BE(4);
            const frameLength = 6 + length;

            if (protocolId !== 0) {
                this._onSocketError(new ModbusError(`Invalid protocol id ${protocolId}`, 'BAD_PROTOCOL'));
                return;
            }
            if (this.buffer.length < frameLength) {
                return;
            }

            const frame = this.buffer.subarray(0, frameLength);
            this.buffer = this.buffer.subarray(frameLength);
            const pdu = frame.subarray(7);
            const pending = this.pending.get(transactionId);
            if (!pending) {
                continue;
            }
            clearTimeout(pending.timer);
            this.pending.delete(transactionId);

            const functionCode = pdu.readUInt8(0);
            if (functionCode & 0x80) {
                const exceptionCode = pdu.readUInt8(1);
                pending.reject(new ModbusError(`Modbus exception ${exceptionCode}`, exceptionCode));
            } else {
                pending.resolve(pdu);
            }
        }
    }

    _onSocketError(err) {
        if (this.logger && typeof this.logger.debug === 'function') {
            this.logger.debug(`Modbus socket error: ${err.message}`);
        }
        this.close();
    }

    _onSocketClose() {
        this.connected = false;
        this.socket = null;
    }
}

module.exports = {
    ModbusTcpClient,
    ModbusError
};
