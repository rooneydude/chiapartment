import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What the tests need of a GitHub workflow: which jobs and steps it has, what
 * each step runs and with which variables — and a way to run a step's
 * command the way the runner does (`bash -e`, a fresh output file, nothing
 * in the environment but what that step would really be given).
 *
 * Not a YAML parser. It reads the one layout this repository writes and
 * refuses anything else — including every setting that would change how a
 * command runs in a way `Project.run` does not reproduce (another shell or
 * working directory, defaults, a container, variables set for the whole job
 * or workflow). A workflow changed in such a way fails the tests that read
 * it instead of quietly escaping them. What it does hand over without
 * acting on it — a step's or job's `if:`, `continue-on-error:` — is in
 * `keys`, for the tests to pin.
 */

export const REPO = join(__dirname, "..", "..", "..");

export interface Step {
  /** `name:`; for a step without one, what it runs or uses. */
  name: string;
  /** `run:` — one command, or the lines of a `run: |` block. Null for a `uses:` step. */
  run: string | null;
  /** The step's `env:` block as written (expressions not filled in). */
  env: Record<string, string>;
  /** Its other keys: `id`, `if`, `uses`, `continue-on-error`. */
  keys: Record<string, string>;
}

export interface Job {
  /** The job's own settings, blocks as "": `runs-on`, `needs`, `if`, `uses`, `outputs`, `permissions`. */
  keys: Record<string, string>;
  steps: Step[];
}

/** Everything a step may say. `shell`, `working-directory`, `timeout-minutes` and the like are not reproduced here, so they are refused. */
const STEP_KEYS = new Set(["name", "id", "uses", "with", "run", "env", "if", "continue-on-error"]);
/** Everything a job may say. Not `env`, `defaults`, `container`, `strategy`, `timeout-minutes`: see above. */
const JOB_KEYS = new Set(["runs-on", "needs", "if", "uses", "outputs", "permissions", "environment", "steps"]);
/** Everything a workflow may say at the top. Not `env` or `defaults`. */
const WORKFLOW_KEYS = new Set(["name", "on", "permissions", "concurrency", "jobs"]);

const indent = (line: string): number => line.length - line.trimStart().length;
const isNoise = (line: string): boolean => line.trim() === "" || line.trim().startsWith("#");
const unquote = (v: string): string => (/^(["']).*\1$/.test(v) ? v.slice(1, -1) : v);

function keyValue(line: string, file: string): [key: string, value: string] {
  const text = line.trim();
  const colon = text.indexOf(":");
  if (colon <= 0) throw new Error(`${file}: cannot read this line of a step: ${JSON.stringify(line)}`);
  return [text.slice(0, colon), text.slice(colon + 1).trim()];
}

function readStep(lines: string[], file: string): Step {
  const step: Step = { name: "", run: null, env: {}, keys: {} };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isNoise(line)) {
      i++;
      continue;
    }
    if (indent(line) !== 8) throw new Error(`${file}: cannot read this line of a step: ${JSON.stringify(line)}`);
    const [key, value] = keyValue(line, file);
    if (!STEP_KEYS.has(key)) {
      throw new Error(`${file}: a step sets "${key}", which the tests that run the workflow's commands do not reproduce: ${JSON.stringify(line)}`);
    }
    i++;
    if (key === "run" && value === "|") {
      const block: string[] = [];
      while (i < lines.length && (lines[i]!.trim() === "" || indent(lines[i]!) >= 10)) block.push(lines[i++]!.slice(10));
      while (block.length > 0 && block[block.length - 1]!.trim() === "") block.pop();
      step.run = block.join("\n");
    } else if (key === "run") {
      // YAML would cut a one-line command at " #"; none is written that way here.
      if (value === "" || value.includes(" #")) throw new Error(`${file}: cannot read this command: ${JSON.stringify(line)}`);
      step.run = value;
    } else if (key === "env" || key === "with") {
      if (value !== "") throw new Error(`${file}: expected a block under ${key}: ${JSON.stringify(line)}`);
      while (i < lines.length && (isNoise(lines[i]!) || indent(lines[i]!) >= 10)) {
        if (!isNoise(lines[i]!) && key === "env") {
          const [name, written] = keyValue(lines[i]!, file);
          step.env[name] = unquote(written);
        }
        i++;
      }
    } else {
      step.keys[key] = unquote(value.replace(/\s+#.*$/, ""));
    }
  }
  step.name = step.keys["name"] ?? step.run ?? step.keys["uses"] ?? "";
  return step;
}

function workflowLines(file: string): string[] {
  const lines = readFileSync(join(REPO, ".github", "workflows", file), "utf8").split("\n");
  for (const line of lines) {
    if (isNoise(line) || indent(line) !== 0) continue;
    const [key] = keyValue(line, file);
    if (!WORKFLOW_KEYS.has(key)) {
      throw new Error(`${file}: the workflow sets "${key}", which the tests that run its commands do not reproduce.`);
    }
  }
  return lines;
}

/** The names of a workflow's jobs, in order. */
export function jobNames(file: string): string[] {
  const lines = workflowLines(file);
  const jobsAt = lines.indexOf("jobs:");
  if (jobsAt === -1) throw new Error(`${file} has no jobs`);
  return lines
    .slice(jobsAt + 1)
    .filter((line) => !isNoise(line) && indent(line) === 2)
    .map((line) => keyValue(line, file)[0]);
}

/** One job of a workflow in `.github/workflows`: its own settings and its steps, in order. */
export function readJob(file: string, job: string): Job {
  const lines = workflowLines(file);
  const start = lines.indexOf(`  ${job}:`);
  if (start === -1) throw new Error(`${file} has no job "${job}"`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (!isNoise(lines[i]!) && indent(lines[i]!) <= 2) {
      end = i;
      break;
    }
  }
  const keys: Record<string, string> = {};
  for (let i = start + 1; i < end; i++) {
    const line = lines[i]!;
    if (isNoise(line) || indent(line) !== 4) continue;
    const [key, value] = keyValue(line, file);
    if (!JOB_KEYS.has(key)) {
      throw new Error(`${file}: the job "${job}" sets "${key}", which the tests that run the workflow's commands do not reproduce.`);
    }
    keys[key] = unquote(value.replace(/\s+#.*$/, ""));
  }
  const steps: Step[] = [];
  const stepsAt = lines.findIndex((line, i) => i > start && i < end && line === "    steps:");
  let current: string[] | null = null;
  for (let i = stepsAt + 1; stepsAt !== -1 && i < end; i++) {
    const line = lines[i]!;
    if (line.startsWith("      - ")) {
      if (current) steps.push(readStep(current, file));
      current = [`        ${line.slice(8)}`];
    } else if (current) current.push(line);
    else if (!isNoise(line)) throw new Error(`${file}: unexpected line before the first step: ${JSON.stringify(line)}`);
  }
  if (current) steps.push(readStep(current, file));
  return { keys, steps };
}

/** The steps of one job, in order. */
export function jobSteps(file: string, job: string): Step[] {
  const { steps } = readJob(file, job);
  if (steps.length === 0) throw new Error(`${file}: the job "${job}" has no steps`);
  return steps;
}

/** The step called `name`; a test that names a step the workflow no longer has should say so. */
export function stepNamed(steps: Step[], name: string): Step {
  const found = steps.filter((s) => s.name === name);
  if (found.length !== 1) throw new Error(`Expected one step named ${JSON.stringify(name)}, found ${found.length}.`);
  return found[0]!;
}

/** Fill in `${{ … }}` as GitHub does before a step starts. Anything this test was not told about is an error. */
export function fillIn(text: string, context: Record<string, string>): string {
  return text.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_whole, expression: string) => {
    const value = context[expression];
    if (value === undefined) {
      throw new Error(`The workflow uses \${{ ${expression} }}, which this test does not know how to fill in.`);
    }
    return value;
  });
}

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
  /** What the command appended to its step's output file, as written. */
  written: string;
  /** The same, as name → value. */
  outputs: Record<string, string>;
}

/**
 * A throwaway copy of the project, as far as the refresh job reads it: the
 * real package.json (so `npm run …` means what it means on GitHub), the real
 * source and recorded responses, the real list of buildings — and its own
 * data folder, trigger file, home directory and runner files, so nothing a
 * command writes lands in this repository or in the job running the tests.
 */
export class Project {
  readonly root: string;
  readonly temp: string;
  readonly summary: string;
  private readonly home: string;
  private runs = 0;

  constructor(name: string, opts: { trigger?: string } = {}) {
    this.root = mkdtempSync(join(tmpdir(), `chiapartment-${name}-`));
    this.home = join(this.root, ".home");
    this.temp = join(this.root, ".runner-temp");
    this.summary = join(this.temp, "summary.md");
    for (const dir of [this.home, this.temp, join(this.root, "scraper"), join(this.root, ".github"), join(this.root, "data", "snapshots")]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.summary, "");
    for (const file of ["package.json", "buildings.json"]) copyFileSync(join(REPO, file), join(this.root, file));
    symlinkSync(join(REPO, "node_modules"), join(this.root, "node_modules"), "dir");
    symlinkSync(join(REPO, "scraper", "src"), join(this.root, "scraper", "src"), "dir");
    symlinkSync(join(REPO, "scraper", "fixtures"), join(this.root, "scraper", "fixtures"), "dir");
    const committed = join(REPO, ".github", "refresh-trigger");
    if (opts.trigger !== undefined) writeFileSync(join(this.root, ".github", "refresh-trigger"), opts.trigger);
    else if (existsSync(committed)) copyFileSync(committed, join(this.root, ".github", "refresh-trigger"));
  }

  /**
   * Run a step's command as the runner does.
   * @param context what `${{ … }}` stands for on this run
   * @param opts.append added to the command (how the scrape is kept offline)
   * @param opts.env variables on top of the step's own (a stand-in program's settings)
   * @param opts.path a folder searched for programs before the machine's own
   */
  run(
    step: Step,
    event: string,
    context: Record<string, string>,
    opts: { append?: string; env?: Record<string, string>; path?: string } = {},
  ): Promise<Ran> {
    if (step.run === null) throw new Error(`The step ${JSON.stringify(step.name)} runs no command.`);
    const output = join(this.temp, `output-${++this.runs}.txt`);
    writeFileSync(output, "");
    // Built from nothing: the variables of the job running these tests (its own GITHUB_OUTPUT above all) stay out.
    const env: Record<string, string> = {
      PATH: `${opts.path ? `${opts.path}:` : ""}${process.env["PATH"] ?? ""}`,
      HOME: this.home,
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: event,
      GITHUB_REPOSITORY: "example/tracker",
      GITHUB_REF_NAME: "main",
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: this.summary,
      RUNNER_TEMP: this.temp,
      npm_config_update_notifier: "false",
      ...opts.env,
    };
    for (const [name, written] of Object.entries(step.env)) env[name] = fillIn(written, context);
    const script = fillIn(step.run, context) + (opts.append ?? "");
    return new Promise((resolve) => {
      execFile("bash", ["-e", "-c", script], { cwd: this.root, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        const written = readFileSync(output, "utf8");
        const outputs: Record<string, string> = {};
        for (const line of written.split("\n")) {
          const eq = line.indexOf("=");
          if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
        }
        resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr, written, outputs });
      });
    });
  }

  remove(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
