# Changelog

## 0.6.10

- Removed `@alcalzone/release-script` from `devDependencies` because the adapter is not using the full release-script workflow yet. This avoids `.releaseconfig.json` checker errors.
- Removed invalid root-level responsive attributes from `admin/jsonConfig.json`.
- Kept responsive size attributes on all Admin form fields that require them.
- Added README linkage for `CHANGELOG_OLD.md` so existing repositories with the old changelog file satisfy the checker.

## 0.6.9

- Added responsive `xs`, `md`, `lg` and `xl` size attributes to all Admin `jsonConfig` items so the current ioBroker checker responsive test passes.
- Added a standard README changelog entry for the current adapter version.
- Kept the robust Unit-ID scan handling from 0.6.8.
- Kept clean cancellation of running polls and scans during unload/terminate.
- Adjusted the GitHub workflow so normal tests run on branches and release tags without failing because the adapter is not published on npm yet.

## 0.6.8

- Added robust Unit-ID scan handling.
- Added debug summary per checked Unit-ID.
- Added per Unit-ID timeout/error handling so one bad Unit-ID does not stop the complete scan.
- Continued scanning after non-responsive Unit-IDs.
- Added clean cancellation of running scans and polls during adapter unload/terminate to avoid DB-closed follow-up errors.

## 0.6.7

- Fixed Modbus TCP connect crash under Node.js 22 by correcting timer cleanup in the Modbus client.

## 0.6.6

- Cleaned release package metadata for ioBroker repository checks.
