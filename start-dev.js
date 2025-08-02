// Development server startup script
process.env.NODE_ENV = 'development';
process.env.PORT = '3000';
process.env.HOST = '0.0.0.0';

// Use child_process to run tsx directly
import { spawn } from 'child_process';

const tsx = spawn('npx', ['tsx', 'server/index.ts'], {
  stdio: 'inherit',
  shell: true
});

tsx.on('error', (error) => {
  console.error('Failed to start server:', error);
});
