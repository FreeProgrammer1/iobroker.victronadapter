# Adapter check preparation report

Version: 0.6.1

Runtime source code kept unchanged:
- main.js
- lib/modbusClient.js
- lib/registerMap.js
- lovelace/victronadapter-card.js

Added/updated non-runtime project files:
- package.json metadata and scripts
- io-package.json metadata
- README.md
- CHANGELOG.md
- admin/index.html fallback for older checks
- .github/workflows/test-and-release.yml
- .github/dependabot.yml
- .gitignore
- .editorconfig
- .npmignore
- test/metadata.test.js

Local checks:
- npm run test:js: OK
- npm run test:unit: OK
- npm run test:package: OK
- npm test: OK

Repository checker:
- Correct command added: npm run adapter-check
- In this sandbox the command reached repochecker 5.19.5 but failed because api.github.com was not reachable / the GitHub repository is not accessible from this environment.
