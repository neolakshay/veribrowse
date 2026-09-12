const { execSync } = require('child_process');
try {
  const out = execSync('echo "help me signup on reddit" | node index.js', { encoding: 'utf8', timeout: 30000 });
  console.log(out);
} catch (e) {
  console.log(e.stdout);
}
