#!/usr/bin/env node
var fs = require('fs')
var args = require('minimist')(process.argv.slice(2), {boolean: ['help']})
var usage = fs.readFileSync(__dirname + '/usage.txt').toString()
var sign = require('./')

if (!args._[0] || args.help) {
  console.log(usage)
  process.exit(0)
}

sign(args._[0], args, function done (err) {
  if (err) {
    if (err.message) console.error(err.message)
    else console.error(err, err.stack)
    process.exit(1)
  }
  console.log('Application signed:', args.app)
})
