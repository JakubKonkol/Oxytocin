import type { Project } from '@shared/domain/project';

/** Letter/emoji on the project colour (18 px, radius 4). */
export function ProjectAvatar({
  project,
  size = 18,
}: {
  project: Pick<Project, 'name' | 'color' | 'icon'>;
  size?: number;
}) {
  const text = project.icon?.value ?? project.name.trim().charAt(0).toUpperCase();
  return (
    <span
      aria-hidden
      className="inline-flex flex-none items-center justify-center rounded-badge font-mono text-[10px] font-semibold text-fg-inverse"
      style={{ width: size, height: size, background: `var(--project-${project.color})` }}
    >
      {text}
    </span>
  );
}
