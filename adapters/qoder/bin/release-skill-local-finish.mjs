#!/usr/bin/env node

if (process.argv[2] !== 'post-release') process.argv.splice(2, 0, 'post-release');
await import('./release-skill.mjs');
