'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { describe, it } = require('node:test');
const { ModbusTcpClient } = require('../lib/modbusClient');

describe('Modbus TCP client', () => {
    it('connects to a TCP server without crashing during timer cleanup', async () => {
        const server = net.createServer(socket => {
            socket.on('error', () => {});
        });

        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        const client = new ModbusTcpClient({ host: '127.0.0.1', port, timeout: 500, logger: console });

        try {
            await client.connect();
            assert.equal(client.connected, true);
        } finally {
            client.destroy();
            await new Promise(resolve => server.close(resolve));
        }
    });
});
