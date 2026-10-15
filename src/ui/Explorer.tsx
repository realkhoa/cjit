import { useState } from 'react';
import { languageForPath } from '@/state/fileStore';
import { useAppStore } from '@/state/store';

/**
 * Solution Explorer: the workspace's projects and their files, stored in the browser.
 *
 * Renaming happens in place rather than in a dialog, and deleting asks once
 * inline - both keep the panel usable without a modal for a two-second action.
 * The project bar sits above the file list: switching projects is the outermost
 * thing you do here, and it is one tap even on a phone.
 */
export function Explorer() {
  const files = useAppStore((state) => state.files);
  const activeFileId = useAppStore((state) => state.activeFileId);
  const openFile = useAppStore((state) => state.openFile);
  const createFile = useAppStore((state) => state.createFile);
  const renameActiveFile = useAppStore((state) => state.renameActiveFile);
  const deleteActiveFile = useAppStore((state) => state.deleteActiveFile);
  const trash = useAppStore((state) => state.trash);
  const restoreTrashed = useAppStore((state) => state.restoreTrashed);
  const emptyTrash = useAppStore((state) => state.emptyTrash);
  const projects = useAppStore((state) => state.projects);
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const projectTrash = useAppStore((state) => state.projectTrash);
  const createProject = useAppStore((state) => state.createProject);
  const switchProject = useAppStore((state) => state.switchProject);
  const renameProject = useAppStore((state) => state.renameProject);
  const deleteProject = useAppStore((state) => state.deleteProject);
  const restoreTrashedProject = useAppStore((state) => state.restoreTrashedProject);
  const emptyProjectTrash = useAppStore((state) => state.emptyProjectTrash);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [projectDraft, setProjectDraft] = useState('');
  const [projectAction, setProjectAction] = useState<'none' | 'new' | 'rename' | 'delete'>('none');
  const [projectError, setProjectError] = useState<string | null>(null);
  const [confirmEmptyProjects, setConfirmEmptyProjects] = useState(false);

  const active = projects.find((project) => project.id === activeProjectId) ?? projects[0];

  const beginRename = (id: string, currentPath: string): void => {
    openFile(id);
    setRenamingId(id);
    setDraft(currentPath);
    setError(null);
  };

  const commitRename = (): void => {
    const outcome = renameActiveFile(draft);
    if (!outcome.ok) {
      setError(outcome.error ?? 'rename failed');
      return;
    }
    setRenamingId(null);
    setError(null);
  };

  const commitProjectAction = (): void => {
    if (projectAction === 'new') {
      createProject(projectDraft);
      setProjectsOpen(false);
    } else if (projectAction === 'rename' && active) {
      const outcome = renameProject(active.id, projectDraft);
      if (!outcome.ok) {
        setProjectError(outcome.error ?? 'rename failed');
        return;
      }
    }
    setProjectAction('none');
    setProjectDraft('');
    setProjectError(null);
  };

  return (
    <>
      <div className="pane__header">
        <span className="pane__title">Explorer</span>
        <span className="watch__count">{files.length}</span>
        <button
          type="button"
          className="icon-btn"
          onClick={() => {
            createFile();
            setError(null);
          }}
          title="Tạo file mới (lưu trong browser)"
          aria-label="New file"
        >
          ＋
        </button>
      </div>

      {error ? <div className="explorer__error">{error}</div> : null}

      <div className="pane__body">
        {/*
          The project bar. Switching projects is the outermost thing you do in the
          explorer, so it is a row above the files rather than a dialog.
        */}
        <div className="explorer__project">
          <button
            type="button"
            className="explorer__project-current"
            onClick={() => {
              setProjectsOpen((open) => !open);
              setProjectAction('none');
              setProjectError(null);
            }}
            aria-expanded={projectsOpen}
            aria-label={`Đổi project (đang mở: ${active?.name ?? 'project'})`}
            title="Đổi project"
          >
            <span className="explorer__caret">{projectsOpen ? '▾' : '▸'}</span>
            <span className="explorer__project-name">{active?.name ?? 'project'}</span>
            <span className="watch__count">{projects.length}</span>
          </button>
        </div>

        {projectsOpen ? (
          <div className="explorer__projects">
            <ul className="explorer__list">
              {projects.map((project) => (
                <li
                  key={project.id}
                  className={
                    project.id === activeProjectId
                      ? 'explorer__row explorer__row--active'
                      : 'explorer__row'
                  }
                >
                  <button
                    type="button"
                    className="explorer__name"
                    onClick={() => {
                      switchProject(project.id);
                      setProjectsOpen(false);
                    }}
                    title={`Mở project "${project.name}"`}
                  >
                    {project.name}
                  </button>
                  <span className="watch__count">{project.files.length}</span>
                </li>
              ))}
            </ul>

            {projectAction === 'none' ? (
              <div className="explorer__row explorer__row--actions">
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => {
                    setProjectAction('new');
                    setProjectDraft('');
                  }}
                >
                  + New project
                </button>
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => {
                    setProjectAction('rename');
                    setProjectDraft(active?.name ?? '');
                  }}
                >
                  Rename
                </button>
                {projects.length > 1 ? (
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => setProjectAction('delete')}
                    title="Chuyển project vào Trash project"
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="explorer__project-form">
                {projectAction === 'delete' ? (
                  <span className="explorer__confirm">
                    <button
                      type="button"
                      className="btn btn--small btn--danger"
                      onClick={() => {
                        if (active) deleteProject(active.id);
                        setProjectAction('none');
                        setProjectsOpen(false);
                      }}
                    >
                      Xoá project "{active?.name}"
                    </button>
                    <button
                      type="button"
                      className="btn btn--small"
                      onClick={() => setProjectAction('none')}
                    >
                      Huỷ
                    </button>
                  </span>
                ) : (
                  <>
                    <input
                      className="explorer__input"
                      value={projectDraft}
                      autoFocus
                      spellCheck={false}
                      aria-label="Project name"
                      placeholder="tên project"
                      onChange={(event) => setProjectDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') commitProjectAction();
                        if (event.key === 'Escape') {
                          setProjectAction('none');
                          setProjectError(null);
                        }
                      }}
                    />
                    <button type="button" className="btn btn--small" onClick={commitProjectAction}>
                      {projectAction === 'new' ? 'Tạo' : 'Lưu'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--small"
                      onClick={() => setProjectAction('none')}
                    >
                      Huỷ
                    </button>
                  </>
                )}
                {projectError ? <span className="explorer__error">{projectError}</span> : null}
              </div>
            )}
          </div>
        ) : null}

        <ul className="explorer__list">
          {files.map((file) => {
            const active = file.id === activeFileId;
            return (
              <li key={file.id} className={active ? 'explorer__row explorer__row--active' : 'explorer__row'}>
                {renamingId === file.id ? (
                  <input
                    className="explorer__input"
                    value={draft}
                    autoFocus
                    spellCheck={false}
                    aria-label="File name"
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitRename();
                      if (event.key === 'Escape') {
                        setRenamingId(null);
                        setError(null);
                      }
                    }}
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      className="explorer__name"
                      onClick={() => openFile(file.id)}
                      onDoubleClick={() => beginRename(file.id, file.path)}
                      title={`${file.path} · ${languageForPath(file.path)} · bấm đôi để đổi tên`}
                    >
                      <span className="explorer__dot" data-language={file.language} />
                      {file.path}
                    </button>

                    {confirmingId === file.id ? (
                      <span className="explorer__confirm">
                        <button
                          type="button"
                          className="icon-btn icon-btn--danger"
                          onClick={() => {
                            deleteActiveFile();
                            setConfirmingId(null);
                          }}
                          title="Xoá thật"
                          aria-label="Confirm delete"
                        >
                          ✓
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => setConfirmingId(null)}
                          title="Huỷ"
                          aria-label="Cancel delete"
                        >
                          ✕
                        </button>
                      </span>
                    ) : (
                      <span className="explorer__actions">
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => beginRename(file.id, file.path)}
                          title="Đổi tên"
                          aria-label={`Rename ${file.path}`}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          disabled={files.length <= 1}
                          onClick={() => {
                            openFile(file.id);
                            setConfirmingId(file.id);
                          }}
                          title={
                            files.length <= 1
                              ? 'Không xoá được file cuối cùng'
                              : `Xoá ${file.path}`
                          }
                          aria-label={`Delete ${file.path}`}
                        >
                          🗑
                        </button>
                      </span>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>

        {/*
          Trash: deleting a file, deleting a project, and Reset all put things here
          instead of destroying them, so "nothing is ever wiped" is true rather than
          a promise. Emptying is the only action that really deletes, and it asks
          first.
        */}
        <div className="explorer__trash">
          <button
            type="button"
            className="explorer__trash-head"
            onClick={() => setTrashOpen((open) => !open)}
            aria-expanded={trashOpen}
            disabled={trash.length === 0 && projectTrash.length === 0}
            title={
              trash.length === 0 && projectTrash.length === 0
                ? 'Trash trống'
                : `${trash.length} file, ${projectTrash.length} project đã xoá — mở để lấy lại`
            }
          >
            <span>{trashOpen ? '▾' : '▸'} Trash</span>
            {trash.length + projectTrash.length > 0 ? (
              <span className="watch__count">{trash.length + projectTrash.length}</span>
            ) : null}
          </button>

          {trashOpen && projectTrash.length > 0 ? (
            <ul className="explorer__list">
              {projectTrash.map((entry) => (
                <li key={entry.id} className="explorer__row">
                  <span
                    className="explorer__name explorer__name--trashed"
                    title={`project ${entry.name} · ${entry.files.length} file`}
                  >
                    📁 {entry.name}
                  </span>
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => restoreTrashedProject(entry.id)}
                    title={`Lấy lại project ${entry.name}`}
                  >
                    Restore
                  </button>
                </li>
              ))}
              <li className="explorer__row">
                {confirmEmptyProjects ? (
                  <span className="explorer__confirm">
                    <button
                      type="button"
                      className="btn btn--small btn--danger"
                      onClick={() => {
                        emptyProjectTrash();
                        setConfirmEmptyProjects(false);
                      }}
                    >
                      Xoá hẳn {projectTrash.length} project
                    </button>
                    <button
                      type="button"
                      className="btn btn--small"
                      onClick={() => setConfirmEmptyProjects(false)}
                    >
                      Huỷ
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => setConfirmEmptyProjects(true)}
                    title="Xoá vĩnh viễn các project trong Trash"
                  >
                    Empty project trash…
                  </button>
                )}
              </li>
            </ul>
          ) : null}

          {trashOpen && trash.length > 0 ? (
            <ul className="explorer__list">
              {trash.map((entry) => (
                <li key={entry.id} className="explorer__row">
                  <span className="explorer__name explorer__name--trashed" title={entry.path}>
                    {entry.path}
                  </span>
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => restoreTrashed(entry.id)}
                    title={`Lấy lại ${entry.path}`}
                  >
                    Restore
                  </button>
                </li>
              ))}
              <li className="explorer__row">
                {confirmEmpty ? (
                  <span className="explorer__confirm">
                    <button
                      type="button"
                      className="btn btn--small btn--danger"
                      onClick={() => {
                        emptyTrash();
                        setConfirmEmpty(false);
                        setTrashOpen(false);
                      }}
                    >
                      Xoá hẳn {trash.length} file
                    </button>
                    <button
                      type="button"
                      className="btn btn--small"
                      onClick={() => setConfirmEmpty(false)}
                    >
                      Huỷ
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => setConfirmEmpty(true)}
                    title="Xoá vĩnh viễn mọi thứ trong Trash"
                  >
                    Empty trash…
                  </button>
                )}
              </li>
            </ul>
          ) : null}
        </div>
      </div>

      <div className="watch__footer">
        {files.reduce((total, file) => total + file.code.length, 0).toLocaleString()} chars · lưu trong
        browser (localStorage)
      </div>
    </>
  );
}
