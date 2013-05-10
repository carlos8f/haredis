test:
	@./node_modules/.bin/mocha \
		--reporter spec \
		--timeout 5s \
		--require test/_common.js

test-cluster:
	@NODE_ENV=test node test

.PHONY: test test-cluster
