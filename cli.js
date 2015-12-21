#!/usr/bin/env node
var fs = require('fs')
var args = require('minimist')(process.argv.slice(2))
var usage = fs.readFileSync(__dirname + '/usage.txt').toString()
var sign = require('./')

args.app = args._[0]

if (args.help) {
  console.log(usage)
  process.exit(0)
}

sign(args, function done (err) {
  if (err) {
    if (err.message) console.error(err.message)
    else console.error(err, err.stack)
    process.exit(1)
  }
})
