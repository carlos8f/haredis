assert = require('assert');
haredis = require('../');
async = require('async');
spawn = require('child_process').spawn;
rimraf = require('rimraf');
mkdirp = require('mkdirp');
idgen = require('idgen');
