REPORTER = spec

test:
	@NODE_ENV=test node test-singlemode

test-cluster:
	@NODE_ENV=test node test

.PHONY: test test-cluster
