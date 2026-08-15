import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist/db/migrations', { recursive: true });
cpSync('src/db/migrations/001_initial.sql', 'dist/db/migrations/001_initial.sql');
