import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'extract_faces.py');
let worker;
let nextId = 1;
const pending = new Map();

function startWorker() {
  if (worker) return worker;
  worker = spawn('python3', [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const output = readline.createInterface({ input: worker.stdout });
  output.on('line', (line) => {
    try {
      const result = JSON.parse(line);
      const request = pending.get(result.id);
      if (!request) return;
      pending.delete(result.id);
      if (result.error) request.reject(new Error(result.error));
      else request.resolve(result.faces || []);
    } catch (error) {
      console.error('Face worker returned invalid JSON:', error.message);
    }
  });
  worker.stderr.on('data', (chunk) => console.error(`Face worker: ${chunk.toString().trim()}`));
  worker.on('error', (error) => failWorker(error));
  worker.on('exit', (code) => {
    if (code !== 0) failWorker(new Error(`Face worker exited with code ${code}`));
    worker = null;
  });
  return worker;
}

function failWorker(error) {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

export function extractFaces(filePath) {
  const process = startWorker();
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    process.stdin.write(`${JSON.stringify({ id, file_path: filePath })}\n`);
  });
}
