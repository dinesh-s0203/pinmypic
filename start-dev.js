// Development server startup script
process.env.NODE_ENV = 'development';
process.env.PORT = '3000';
process.env.HOST = '127.0.0.1';

import('tsx').then(tsx => {
  tsx.default.run('./server/index.ts');
}).catch(console.error);
