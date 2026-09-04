// public/qimg is gitignored, so a git worktree gets it as a directory junction
// rather than a copy. wrangler's asset walker does not follow that junction: the
// deploy succeeds, reports "Read 3 files from the assets directory", and writes a
// manifest with none of the crops in it - so every figure and every notation image
// 404s in production until someone deploys again from a checkout that has them.
// Node's readdirSync sees all 4,915 files through the junction, so only lstat
// tells the two apart.
const fs = require('fs');
const dir = 'public/qimg';

let st;
try { st = fs.lstatSync(dir); } catch (e) {
  console.error(`predeploy: ${dir} is missing. Run the extractor, or copy it from another checkout.`);
  process.exit(1);
}
if (st.isSymbolicLink()) {
  console.error(`predeploy: ${dir} is a symlink/junction. wrangler will skip it and the crops will 404.\n` +
                `  cp -rL ${dir} ${dir}_real && rm ${dir} && mv ${dir}_real ${dir}`);
  process.exit(1);
}
const n = fs.readdirSync(dir).length;
if (n < 4000) {
  console.error(`predeploy: ${dir} holds ${n} files; expected ~4,900. Deploying would 404 the missing crops.`);
  process.exit(1);
}
console.log(`predeploy: ${dir} ok (${n} files).`);
