#!/usr/bin/env node

import { runExportSessionCli } from "../dist/cli/export-session.js";

process.exitCode = runExportSessionCli(process.argv.slice(2));
