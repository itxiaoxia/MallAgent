use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

const FALLBACK_PORT: u16 = 45831;

#[derive(Debug, Clone, PartialEq, Eq)]
struct BackendCommandSpec {
    program: PathBuf,
    args: Vec<String>,
    current_dir: PathBuf,
}

pub struct BackendState {
    port: u16,
    child: Mutex<Option<Child>>,
}

impl BackendState {
    fn new(port: u16) -> Self {
        Self {
            port,
            child: Mutex::new(None),
        }
    }

    fn install(&self, child: Child) -> Result<(), String> {
        self.child
            .lock()
            .map_err(|_| "backend process state is poisoned".to_string())?
            .replace(child);
        Ok(())
    }

    fn stop(&self) {
        let Ok(mut child) = self.child.lock() else {
            return;
        };
        let Some(mut child) = child.take() else {
            return;
        };
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for BackendState {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn backend_url_for_port(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn backend_command_spec(
    debug: bool,
    project_root: &Path,
    resource_dir: &Path,
    port: u16,
) -> BackendCommandSpec {
    let backend_dir = project_root.join("backend");
    let mut args = Vec::new();
    let program = if debug {
        let venv_python = if cfg!(windows) {
            project_root
                .join(".venv")
                .join("Scripts")
                .join("python.exe")
        } else {
            project_root.join(".venv").join("bin").join("python")
        };
        if venv_python.exists() {
            venv_python
        } else if cfg!(windows) {
            args.push("-3.11".to_string());
            PathBuf::from("py")
        } else {
            PathBuf::from("python3.11")
        }
    } else {
        resource_dir.join("backend").join(if cfg!(windows) {
            "mallagent-backend.exe"
        } else {
            "mallagent-backend"
        })
    };
    if debug {
        args.extend(["-m".to_string(), "mallagent".to_string()]);
    }
    args.extend([
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--port".to_string(),
        port.to_string(),
    ]);
    BackendCommandSpec {
        program,
        args,
        current_dir: if debug {
            backend_dir
        } else {
            resource_dir.to_path_buf()
        },
    }
}

fn available_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

fn spawn_backend(app: &AppHandle, port: u16) -> Result<Child, Box<dyn std::error::Error>> {
    let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| std::io::Error::other("unable to resolve project root"))?
        .to_path_buf();
    let resource_dir = app.path().resource_dir()?;
    let spec = backend_command_spec(cfg!(debug_assertions), &project_root, &resource_dir, port);
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .current_dir(&spec.current_dir)
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    Ok(command.spawn()?)
}

#[tauri::command]
fn backend_url(state: State<'_, BackendState>) -> String {
    backend_url_for_port(state.port)
}

pub fn run() {
    let port = available_port().unwrap_or(FALLBACK_PORT);
    tauri::Builder::default()
        .manage(BackendState::new(port))
        .invoke_handler(tauri::generate_handler![backend_url])
        .setup(move |app| {
            let child = spawn_backend(app.handle(), port)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            app.state::<BackendState>()
                .install(child)
                .map_err(std::io::Error::other)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running MallAgent");
}

#[cfg(test)]
mod tests {
    use super::{backend_command_spec, backend_url_for_port};
    use std::path::Path;

    #[test]
    fn backend_url_uses_loopback_and_selected_port() {
        assert_eq!(backend_url_for_port(45831), "http://127.0.0.1:45831");
    }

    #[test]
    fn debug_command_runs_the_project_python_module() {
        let spec = backend_command_spec(
            true,
            Path::new("C:/project"),
            Path::new("C:/resources"),
            40123,
        );

        assert!(spec.args.ends_with(&[
            "-m".to_string(),
            "mallagent".to_string(),
            "--host".to_string(),
            "127.0.0.1".to_string(),
            "--port".to_string(),
            "40123".to_string(),
        ]));
        assert_eq!(spec.current_dir, Path::new("C:/project/backend"));
    }

    #[test]
    fn release_command_uses_the_packaged_backend_resource() {
        let spec = backend_command_spec(
            false,
            Path::new("C:/project"),
            Path::new("C:/resources"),
            40123,
        );

        assert!(spec
            .program
            .ends_with("resources/backend/mallagent-backend.exe"));
        assert_eq!(
            spec.args,
            ["--host", "127.0.0.1", "--port", "40123"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
        assert_eq!(spec.current_dir, Path::new("C:/resources"));
    }
}
