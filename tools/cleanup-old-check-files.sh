#!/usr/bin/env bash
set -euo pipefail

# Run from repository root before copying the new source files.
rm -f .npmignore .prettierignore CHANGELOG.md ADAPTER_CHECK_REPORT.md
rm -f admin/index.html
rm -rf admin/i18n/de admin/i18n/en admin/i18n/ru admin/i18n/pt admin/i18n/nl admin/i18n/fr admin/i18n/it admin/i18n/es admin/i18n/pl admin/i18n/uk admin/i18n/zh-cn

echo "Old ioBroker checker problem files removed."
