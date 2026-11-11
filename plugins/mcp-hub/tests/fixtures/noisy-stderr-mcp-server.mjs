for (let i = 0; i < 151; i++) {
  process.stderr.write(`line-${i}\n`);
}
process.stderr.write("trailing-no-newline");
