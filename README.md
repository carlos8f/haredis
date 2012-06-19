haredis
-------

High-availability redis in Node.js

Idea
====

**haredis** is a code wrapper around [node_redis](https://github.com/mranney/node_redis)
which adds fault-taulerance to your application.

Features:

- Drop-in replacement for [node_redis](https://github.com/mranney/node_redis)
- Easily build a cluster out of 3 or more (default-configured) redis servers
- Auto-failover due to connection drops
- Master conflict resolution (default your servers to master, and **haredis**
  will elect the freshest and issue the `SLAVEOF` commands)
- Freshness judged by an opcounter (incremented on write)
- Locking mechanism to prevent failover contention
- Load-balancing for reads and pub/sub
- One-client pub/sub
- Gossip channel for quick failover

Usage
=====

Start up multiple redis daemons, with no special configuration necessary, and
list them like so:

```javascript
var redis = require('haredis')
  , nodes = ['1.2.3.1:6379', '1.2.3.2:6379', '1.2.3.3:6379']
  , client = redis.createClient(nodes)
  ;
```

...then use `client` as you would use [node_redis](https://github.com/mranney/node_redis).
If the master node goes down, **haredis** will automatically determine which node
to promote to master, and keep standby connections to the others.

If multiple **haredis** clients are connected, a locking mechanism is implemented
to prevent contention between failover attempts.

To see this in action,

- Set up 3 local redis daemons on ports 6380-82
- 6380 should be `SLAVEOF NO ONE`. 6381 and 82 should be slaves to 6380.
- Run `test/basic.js` or `test/pubsub.js` (try multiple to test contention)
- Kill the process listening on 6380 (master). **haredis** will auto-failover to
  the node it detects is freshest, set that to master, and the others to slaves!
- Bring up 6380, and it will be added as standby for failover.

API difference: createClient
============================

In **haredis**, `createClient` works like this:

```javascript
function createClient([host/port array], options)
```

The first argument can be an array of hosts (using default port), ports (using
localhost), or colon-separated strings (i.e., `1.2.3.4:6379`). **haredis** will
attempt to connect to all of these servers.

`options` corresponds to the same options you would pass
[node_redis](https://github.com/mranney/node_redis). **haredis**
additionally supports:

- `haredis_db_num` {Number} database number that **haredis** should store metadata
  in (such as an opcounter). Defaults to `15`.

Load-balancing
==============

**haredis** can also load-balance read operations to random slaves. Pub/sub
subscriptions will automatically try to use a slave. For normal read-only
commands, you can choose to query a random slave by using the `slaveOk()` method:

```javascript
client.slaveOk().GET('foo', function(err, reply) { ...
```

`slaveOk()` will only affect the current command.

To load-balance all reads, you can set `options.auto_slaveok = true` in
`createClient()`. Be advised that this can case problems due to replication delay!

One-client pub/sub
==================

In redis, pub/sub is a "mode" which excludes the use of regular commands while
subscriptions are active. Normally you need to make separate client objects to
use `publish` on one and `subscribe` on the other.

**haredis** adds the nice ability to use pub/sub simultaneously with regular
commands. This is because it keeps internal redis clients in pub/sub mode for
internal "gossip", but also makes it available for users. Of course this is
optional, and you can always maintain a separate `haredis` client for subscribes
if you wish.

Advice
======

For proper failover, a majority of the nodes need to be still online. This means
that the minimum number of nodes should be 3. Under the minimum setup, you can
lose up to 1 node. If only 1/3 are up, commands will be queued indefinitely until
another node comes up.

Debugging/verbose logging
=========================

To see what's under the hood, try setting `redis.debug_mode = true`, and you can
see the failover process in detail:

```
[19:27:58](#1) warning: MASTER is down! (127.0.0.1:6380)
[19:27:58](#1) info: reorientating (node down) in 2000ms
Redis connection gone from end event.
[19:28:00](#1) info: orientating (node down, 2/3 nodes up) ...
[19:28:00](#1) warning: invalid master count: 0
[19:28:00](#1) info: attempting failover!
[19:28:00](#1) info: my failover id: gP0SCM1B
[19:28:00](#1) info: lock was a success!
[19:28:00](#1) info: 127.0.0.1:6381 had highest opcounter (1441) of 2 nodes. congrats!
[19:28:00](#1) info: making 127.0.0.1:6382 into a slave...
[19:28:00](#1) info: 127.0.0.1:6382 is slave
[19:28:00](#1) info: publishing gossip:master for 127.0.0.1:6381
[19:28:00](#1) info: renegotating subSlave away from master
[19:28:00](#1) info: subSlave is now 127.0.0.1:6382
[19:28:00](#1) info: ready, using 127.0.0.1:6381 as master
```

To get info on which commands are executed on which servers, try setting
`redis.command_logging = true`.

Running tests
=============

**haredis** includes the test suite from [node_redis](https://github.com/mranney/node_redis)
which can be run in single or clustered mode.

If you have redis daemons running locally on ports 6380, 6381 and 8382, you can
run the clustered test with:

```bash
$ make test-cluster
```

Or in single-mode with a redis server on port 6379:

```bash
$ make test
```

LICENSE - "MIT License"
=======================

- Copyright (c) 2012 Carlos Rodriguez, http://s8f.org/
- Copyright (c) 2012 Terra Eclipse, Inc., http://www.terraeclipse.com/

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.