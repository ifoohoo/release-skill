#!/usr/bin/env node

// @decision D-RS-002
// @decision D-RS-004
// @feature REL002
// @scenario S-003

if (process.argv[2] !== 'post-release') process.argv.splice(2, 0, 'post-release');
await import('./release-skill.mjs');
