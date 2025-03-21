#!/bin/sh

set -eo pipefail

KEY_CHAIN=/Library/Keychains/System.keychain
dir="$(dirname $0)"/.working

cleanup() {
    rm -rf "$dir"
}

trap cleanup EXIT

# Clean Up
cleanup

# Create Working Dir
mkdir -p "$dir"

echo Generating Certificate

# Generate Certs
openssl req -newkey rsa:2048 -nodes -keyout "$dir"/private.pem -x509 -days 1 -out "$dir"/certificate.pem -extensions extended -config "$(dirname $0)"/codesign.cnf

echo Generating Private Key

openssl x509 -inform PEM -in "$dir"/certificate.pem -outform DER -out "$dir"/certificate.cer

rm -f "$dir"/certificate.pem

echo Importing Certificate

sudo security -v add-trusted-cert -r trustRoot -d -k $KEY_CHAIN "$dir"/certificate.cer

echo Importing Private Key

sudo security import "$dir"/private.pem -k $KEY_CHAIN -T /usr/bin/codesign
