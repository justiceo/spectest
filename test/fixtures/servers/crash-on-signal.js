console.error('fixture self-signal crash');
process.kill(process.pid, 'SIGTERM');
