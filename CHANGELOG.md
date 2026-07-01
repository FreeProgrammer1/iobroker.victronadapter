# Changelog

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
