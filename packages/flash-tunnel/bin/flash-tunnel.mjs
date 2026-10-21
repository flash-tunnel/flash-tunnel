#!/usr/bin/env node
'use strict'

import process from 'node:process'
import { runCli } from '@flash-tunnel/cli'

runCli().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
