import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Task } from '../shared/task';
import { absoluteRulePath, claudeSettings, prepareTaskFiles, readPlanFile, removeTaskFiles, taskFiles } from './files';

const task = { id: 'aaaaaaaa-0000-4000-8000-000000000001', description: 'Add "search"\nNow.', startedAt: 0 } as Task;
const other = { ...task, id: 'aaaaaaaa-0000-4000-8000-000000000002' };

describe('task files', () => {
  it('writes the task, the skills and a .gitignore, and keeps a plan with ticks unless told to replace it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oxy-task-files-'));
    const files = await prepareTaskFiles(root, task);
    expect(files).toEqual(taskFiles(root, task.id));
    expect(files.plan).toBe(join(root, '.oxy', 'tasks', task.id, 'plan.md'));
    expect(JSON.parse(await readFile(files.task, 'utf8'))).toEqual({
      version: 1,
      id: task.id,
      createdAt: '1970-01-01T00:00:00.000Z',
      description: 'Add "search"\nNow.',
    });
    expect(await readFile(join(root, '.oxy', 'tasks', '.gitignore'), 'utf8')).toBe('*\n');
    expect((await readdir(join(root, '.oxy', 'tasks', 'skills'))).sort()).toEqual([
      'implement.md',
      'plan.md',
      'review.md',
    ]);
    expect(await readPlanFile(files.plan)).toBeNull();
    // A skill edited by hand is brought back to the built-in text.
    await writeFile(files.skills.planner, 'changed');
    await prepareTaskFiles(root, task, { text: 'Plan', replace: false });
    expect(await readFile(files.skills.planner, 'utf8')).toContain('# Oxytocin Task: write the plan');
    expect(await readFile(files.plan, 'utf8')).toBe('Plan\n');
    await writeFile(files.plan, 'Plan [x]\n');
    await prepareTaskFiles(root, task, { text: 'Plan', replace: false });
    expect(await readPlanFile(files.plan)).toMatchObject({ text: 'Plan [x]\n' });
    await prepareTaskFiles(root, task, { text: 'Plan', replace: true });
    expect(await readFile(files.plan, 'utf8')).toBe('Plan\n');
  });

  it('removes a task folder, the shared files with the last task, and .oxy only when it is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oxy-task-files-'));
    await prepareTaskFiles(root, task);
    await prepareTaskFiles(root, other);
    await removeTaskFiles(root, task.id);
    expect((await readdir(join(root, '.oxy', 'tasks'))).sort()).toEqual(['.gitignore', other.id, 'skills'].sort());
    await mkdir(join(root, '.oxy', 'code-map'));
    await removeTaskFiles(root, other.id);
    expect(await readdir(join(root, '.oxy'))).toEqual(['code-map']);
    // Removing what is not there is fine (the folder was deleted by hand).
    await removeTaskFiles(root, other.id);
    const empty = await mkdtemp(join(tmpdir(), 'oxy-task-files-'));
    await prepareTaskFiles(empty, task);
    await removeTaskFiles(empty, task.id);
    expect(await readdir(empty)).toEqual([]);
  });

  it('reports a plan file beyond the size limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oxy-task-files-'));
    const files = await prepareTaskFiles(root, task);
    await writeFile(files.plan, 'x'.repeat(90_001));
    expect(await readPlanFile(files.plan)).toEqual({ tooLarge: true });
    await writeFile(files.plan, '  \n');
    expect(await readPlanFile(files.plan)).toBeNull();
  });
});

describe('Claude Code settings of a Task session', () => {
  it('spells absolute paths the way permission rules expect', () => {
    expect(absoluteRulePath('C:\\Users\\me\\repo\\')).toBe('//c/Users/me/repo');
    expect(absoluteRulePath('/home/me/repo/')).toBe('//home/me/repo');
  });

  it('lets every role read the task files and only the writing roles change the task folder', () => {
    const root = join(tmpdir(), 'repo');
    const files = taskFiles(root, task.id);
    const tasks = absoluteRulePath(join(root, '.oxy', 'tasks'));
    expect(tasks.startsWith('//')).toBe(true);
    expect(tasks.endsWith('/repo/.oxy/tasks')).toBe(true);
    expect(tasks).not.toContain('\\');
    expect(claudeSettings(root, files, 'planner')).toEqual({
      permissions: { allow: [`Read(${tasks}/**)`, `Edit(${tasks}/${task.id}/**)`] },
    });
    expect(claudeSettings(root, files, 'implementer').permissions.allow).toHaveLength(2);
    expect(claudeSettings(root, files, 'reviewer').permissions.allow).toEqual([`Read(${tasks}/**)`]);
  });
});
