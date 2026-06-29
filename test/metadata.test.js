'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const io = JSON.parse(fs.readFileSync(path.join(root, 'io-package.json'), 'utf8'));

describe('adapter metadata', () => {
    it('uses matching package and io-package versions', () => {
        assert.equal(pkg.version, io.common.version);
    });

    it('uses the correct lowercase package and adapter names', () => {
        assert.equal(pkg.name, 'iobroker.victronadapter');
        assert.equal(io.common.name, 'victronadapter');
    });

    it('contains the required runtime files', () => {
        for (const file of ['main.js', 'io-package.json', 'package.json', 'admin/jsonConfig.json', 'admin/victronadapter.svg']) {
            assert.equal(fs.existsSync(path.join(root, file)), true, `${file} is missing`);
        }
    });

    it('contains clean canonical Lovelace files only', () => {
        assert.equal(fs.existsSync(path.join(root, 'lovelace/victronadapter-card.js')), true);
        assert.equal(fs.existsSync(path.join(root, 'lovelace/victronadapter-flow.yaml')), true);
        assert.equal(fs.existsSync(path.join(root, 'lovelace/victronadapter-flow-circle.yaml')), true);
    });
});
