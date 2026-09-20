use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    path: String,
    is_directory: bool,
}

#[derive(Serialize)]
pub struct SearchResult {
    entries: Vec<ProjectFile>,
    truncated: bool,
}

fn project_root(cwd: &str) -> Result<PathBuf, String> {
    let root = Path::new(cwd);
    if !root.is_absolute() || !root.is_dir() {
        return Err("Invalid project directory".into());
    }
    root.canonicalize().map_err(|error| error.to_string())
}

fn match_score(path: &str, query: &str) -> Option<usize> {
    let path = path.to_lowercase();
    if query.is_empty() {
        return Some(path.len());
    }
    let name = path.rsplit('/').next().unwrap_or(&path);
    if name == query {
        return Some(0);
    }
    if name.starts_with(query) {
        return Some(10 + path.len());
    }
    if path.contains(query) {
        return Some(100 + path.len());
    }
    let mut chars = path.chars();
    query
        .chars()
        .all(|needle| chars.by_ref().any(|ch| ch == needle))
        .then_some(1000 + path.len())
}

fn search(cwd: &str, query: &str) -> Result<SearchResult, String> {
    let root = project_root(cwd)?;
    let query = query.replace('\\', "/");
    let subtree = query
        .rsplit_once('/')
        .map(|(prefix, _)| root.join(prefix))
        .filter(|path| path.starts_with(&root) && path.is_dir());
    let query = query.to_lowercase();
    let started = Instant::now();
    let mut matches = Vec::new();
    let mut truncated = false;
    // 每次查询读取最新目录状态；不跟随符号链接，不扫描被忽略的依赖目录。
    let walker = ignore::WalkBuilder::new(&root)
        .require_git(false)
        .follow_links(false)
        .max_depth(Some(32))
        .filter_entry(move |entry| {
            subtree.as_ref().map_or(true, |prefix| {
                entry.depth() == 0
                    || entry.path().starts_with(prefix)
                    || prefix.starts_with(entry.path())
            })
        })
        .build();
    for (count, entry) in walker.enumerate() {
        if count >= 50_000 || started.elapsed() > Duration::from_millis(350) {
            truncated = true;
            break;
        }
        let Ok(entry) = entry else { continue };
        let Some(kind) = entry.file_type() else {
            continue;
        };
        if entry.depth() == 0 || (!kind.is_file() && !kind.is_dir()) {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(&root) else {
            continue;
        };
        let Some(relative) = relative.to_str() else {
            continue;
        };
        // Unix 文件名中的反斜杠不能当成目录分隔符重写。
        let relative = if cfg!(windows) {
            relative.replace('\\', "/")
        } else {
            relative.to_owned()
        };
        if let Some(score) = match_score(&relative, &query) {
            matches.push((
                score,
                ProjectFile {
                    path: relative,
                    is_directory: kind.is_dir(),
                },
            ));
        }
    }
    matches.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.path.cmp(&b.1.path)));
    truncated |= matches.len() > 30;
    let entries = matches.into_iter().take(30).map(|(_, item)| item).collect();
    Ok(SearchResult { entries, truncated })
}

fn resolve(cwd: &str, paths: &[String]) -> Result<Vec<ProjectFile>, String> {
    let root = project_root(cwd)?;
    if paths.len() > 100 {
        return Err("Too many file references".into());
    }
    paths
        .iter()
        .map(|value| {
            let relative = Path::new(value);
            if relative.is_absolute()
                || relative.components().any(|part| {
                    matches!(
                        part,
                        Component::ParentDir | Component::Prefix(_) | Component::RootDir
                    )
                })
            {
                return Err(format!("Reference is outside the project: {value}"));
            }
            let absolute = root
                .join(relative)
                .canonicalize()
                .map_err(|_| format!("Reference is unavailable: {value}"))?;
            if !absolute.starts_with(&root) {
                return Err(format!("Reference is outside the project: {value}"));
            }
            if !absolute.is_file() && !absolute.is_dir() {
                return Err(format!("Reference is not a file or directory: {value}"));
            }
            Ok(ProjectFile {
                path: absolute
                    .to_str()
                    .ok_or("Unsupported path encoding")?
                    .to_owned(),
                is_directory: absolute.is_dir(),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn search_project_files(cwd: String, query: String) -> Result<SearchResult, String> {
    tauri::async_runtime::spawn_blocking(move || search(&cwd, &query))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn resolve_project_references(
    cwd: String,
    paths: Vec<String>,
) -> Result<Vec<ProjectFile>, String> {
    tauri::async_runtime::spawn_blocking(move || resolve(&cwd, &paths))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("monet-files-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(root.join("src/中文 目录")).unwrap();
            std::fs::write(root.join("src/中文 目录/a.ts"), "example").unwrap();
            std::fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
            std::fs::create_dir(root.join("ignored")).unwrap();
            std::fs::write(root.join("ignored/secret.ts"), "example").unwrap();
            Self(root)
        }
        fn cwd(&self) -> &str {
            self.0.to_str().unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn finds_files_and_directories_and_observes_changes_and_ignores() {
        let fixture = Fixture::new();
        let result = search(fixture.cwd(), "").unwrap();
        assert!(result
            .entries
            .iter()
            .any(|item| item.path == "src/中文 目录" && item.is_directory));
        assert!(!result
            .entries
            .iter()
            .any(|item| item.path.contains("ignored")));
        assert_eq!(search(fixture.cwd(), "中文a").unwrap().entries.len(), 1);
        std::fs::write(fixture.0.join("added.rs"), "").unwrap();
        assert_eq!(
            search(fixture.cwd(), "added").unwrap().entries[0].path,
            "added.rs"
        );
        std::fs::remove_file(fixture.0.join("added.rs")).unwrap();
        assert!(resolve(fixture.cwd(), &["added.rs".into()]).is_err());
    }

    #[test]
    fn resolves_unicode_and_directories_but_rejects_escape() {
        let fixture = Fixture::new();
        let values = resolve(fixture.cwd(), &["src/中文 目录/a.ts".into(), "src/".into()]).unwrap();
        assert!(!values[0].is_directory);
        assert!(values[1].is_directory);
        assert!(Path::new(&values[0].path).is_absolute());
        assert!(resolve(fixture.cwd(), &["../outside".into()]).is_err());
        assert!(resolve(fixture.cwd(), &[fixture.cwd().into()]).is_err());
    }

    #[test]
    fn limits_results_and_allows_narrowing_without_bypassing_ignores() {
        let fixture = Fixture::new();
        for index in 0..40 {
            std::fs::write(fixture.0.join(format!("file-{index}.rs")), "").unwrap();
        }
        let results = search(fixture.cwd(), "file").unwrap();
        assert_eq!(results.entries.len(), 30);
        assert!(results.truncated);
        let results = search(fixture.cwd(), "src/中文 目录/a").unwrap();
        assert_eq!(results.entries.len(), 1);
        assert_eq!(results.entries[0].path, "src/中文 目录/a.ts");
        assert!(search(fixture.cwd(), "ignored/secret")
            .unwrap()
            .entries
            .is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinks_outside_the_project() {
        let fixture = Fixture::new();
        std::os::unix::fs::symlink(std::env::temp_dir(), fixture.0.join("outside")).unwrap();
        assert!(resolve(fixture.cwd(), &["outside/".into()]).is_err());
        assert!(search(fixture.cwd(), "outside").unwrap().entries.is_empty());
    }
}
