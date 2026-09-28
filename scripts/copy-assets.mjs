import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist/db/migrations', { recursive: true });
cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
cpSync('src/db/operational-state.sql', 'dist/db/operational-state.sql');
