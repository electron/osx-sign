#!/usr/bin/env node
var fs = require('fs')
var args = require('minimist')(process.argv.slice(2), {boolean: ['help', 'verbose']})
var usage = fs.readFileSync(__dirname + '/electron-osx-sign-usage.txt').toString()
var sign = require('../')

args.app = args._.shift()

if (!args.app || args.help) {
  console.log(usage)
  process.exit(0)
}

// Remove excess arguments
delete args._
delete args.help

sign(args, function done (err) {
  if (err) {
    console.error('Sign failed.')
    if (err.message) console.error(err.message)
    else console.error(err, err.stack)
    process.exit(1)
  }
  console.log('Application signed:', args.app)
  process.exit(0)
})