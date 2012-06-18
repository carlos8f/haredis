haredis
-------

High-availability in Node.js

Idea
====

**haredis** is a code wrapper around [node_redis](https://github.com/mranney/node_redis)
which adds fault-taulerance to your application. Start up multiple redis daemons,
with no special configuration necessary, and list them like so:

```javascript
var redis = require('haredis')
  , nodes = ['1.2.3.1:6379', '1.2.3.2:6379', '1.2.3.3:6379']
  , client = redis.createClient(nodes)
  ;
```

...and you can use `client` as you would normally. **haredis** will automatically
determine which node should be master, and keep standby connections to the others.

To see this in action,

- Set up 3 local redis daemons on ports 6380-82
- 6380 should be `SLAVEOF NO ONE`. 6381 and 82 should be slaves to 6380.
- Run `test/basic.js` or `test/pubsub.js` (try multiple to test contention)
- Kill the process listening on 6380 (master). **haredis** will auto-failover to
  the node it detects is freshest, set that to master, and the others to slaves!
- Bring up 6380, and it will be added as standby for failover.

To see what's under the hood, try setting `redis.debug_mode = true`, and you can
see the failover process in detail:

```
[19:27:58](#1) info: set on 127.0.0.1:6380 (master default)
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
[19:28:00](#1) info: set on 127.0.0.1:6381 (master default)
```

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

LICENSE - "MIT License"
=======================

Copyright (c) 2012 Carlos Rodriguez, http://s8f.org/

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