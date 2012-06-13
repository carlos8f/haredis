Usage
=====

Node app uses

```javascript
var client = require('haredis').createClient(['localhost:6379', 'localhost:6380', 'localhost:6381'], options);
```

Writes go to master, reads go to random slave (if `client.slaveOk()` is done before the command).

createClient
============

Client makes a connection to random node ("scout"). if fails, tries another one after timeout.

checks `server_info.role`
  if 'master'
    use scout connection as master
    pick random node to connect to as slave
      if fails, repeat after timeout.
      if all fails, use master only
  if 'slave'
    if master_link_status:down
      if master_sync_in_progress
        retry from new scout
      else, initiate failover (link down and no sync)
    connect to `server_info.master_host` and `server_info.master_port` as master
      if fails, master apprears down. initiate failover
    use scout as slave

if slave's `server_info.role` is 'master' (2 masters), do `SLAVEOF host port` on slave.
  query master while slave syncs

open separate connection to slave, and do `SUBSCRIBE haredis:master`

Failover (master down)
======================

Attempt to "lock" all the slaves

generate random id

iterate slaves and:
  (MULTI)
    `SETNX haredis:failover (id)`
    `GET haredis:failover`
  if it's our id
    `EXPIRE haredis:failover (ttl)`
    continue.
  else, roll back other nodes (`DEL` keys) and wait (randomized timeout)

once all are iterated,
  pick slave with lowest master_last_io_seconds_ago as master
  `SLAVEOF NO ONE` on that node
  `SLAVEOF host port` on other nodes
  `PUBLISH haredis:master host:port` on master

event on `haredis:master` channel cancels failover process
  connect to that node as master
  use existing slave

Failover (slave down)
=====================

Pick another random slave