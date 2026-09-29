use std::env;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent, State};

const FALLBACK_PORT: u16 = 45831;
pub const DEFAULT_JAVA_MCP_PORT: u16 = 9991;
const JAVA_MCP_HOST: &str = "127.0.0.1";
const JAVA_READINESS_TIMEOUT: Duration = Duration::from_secs(45);
const JAVA_READINESS_PROBE_TIMEOUT: Duration = Duration::from_millis(500);
const JAVA_READINESS_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, PartialEq, Eq)]
struct BackendCommandSpec {
    program: PathBuf,
    args: Vec<String>,
    current_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct JavaCommandSpec {
    program: PathBuf,
    args: Vec<String>,
    current_dir: PathBuf,
    env: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JavaServiceState {
    Starting,
    Stopped,
    Running,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct JavaServiceStatus {
    pub state: JavaServiceState,
    pub port: u16,
    pub url: String,
    pub error: Option<String>,
}

struct JavaProcessState {
    port: u16,
    child: Option<Child>,
    state: JavaServiceState,
    error: Option<String>,
    generation: u64,
}

impl JavaProcessState {
    fn new() -> Self {
        Self {
            port: DEFAULT_JAVA_MCP_PORT,
            child: None,
            state: JavaServiceState::Stopped,
            error: None,
            generation: 0,
        }
    }
}

pub struct BackendState {
    port: u16,
    child: Mutex<Option<Child>>,
    java: Mutex<JavaProcessState>,
}

fn terminate_child(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        let pid = child.id().to_string();
        let mut taskkill = Command::new("taskkill");
        taskkill
            .args(["/PID", pid.as_str(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000);
        let _ = taskkill.status();
    }

    let _ = child.kill();
    let _ = child.wait();
}

impl BackendState {
    fn new(port: u16) -> Self {
        Self {
            port,
            child: Mutex::new(None),
            java: Mutex::new(JavaProcessState::new()),
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
        terminate_child(&mut child);
    }

    #[cfg(test)]
    fn install_java(&self, child: Child, port: u16) -> Result<(), String> {
        let mut state = self
            .java
            .lock()
            .map_err(|_| "Java service process state is poisoned".to_string())?;
        if let Some(mut previous) = state.child.take() {
            terminate_child(&mut previous);
        }
        state.generation = state.generation.wrapping_add(1);
        state.port = port;
        state.state = JavaServiceState::Running;
        state.error = None;
        state.child = Some(child);
        Ok(())
    }

    fn begin_java_start(&self, port: u16) -> Result<u64, String> {
        let mut state = self
            .java
            .lock()
            .map_err(|_| "Java service process state is poisoned".to_string())?;
        if let Some(mut previous) = state.child.take() {
            terminate_child(&mut previous);
        }
        state.generation = state.generation.wrapping_add(1);
        state.port = port;
        state.state = JavaServiceState::Starting;
        state.error = None;
        Ok(state.generation)
    }

    fn install_java_starting(
        &self,
        child: Child,
        port: u16,
        generation: u64,
    ) -> Result<(), String> {
        let mut state = self
            .java
            .lock()
            .map_err(|_| "Java service process state is poisoned".to_string())?;
        if state.generation != generation || state.state != JavaServiceState::Starting {
            drop(state);
            let mut child = child;
            terminate_child(&mut child);
            return Err("Java service start was superseded".to_string());
        }
        state.port = port;
        state.error = None;
        state.child = Some(child);
        Ok(())
    }

    fn poll_java_start(&self, generation: u64) -> Result<Option<ExitStatus>, String> {
        let mut state = self
            .java
            .lock()
            .map_err(|_| "Java service process state is poisoned".to_string())?;
        if state.generation != generation || state.state != JavaServiceState::Starting {
            return Err("Java service start was superseded".to_string());
        }
        let Some(child) = state.child.as_mut() else {
            return Ok(None);
        };
        child
            .try_wait()
            .map_err(|error| format!("Unable to inspect Java MCP during startup: {error}"))
    }

    fn mark_java_running(&self, generation: u64) -> Result<(), String> {
        let mut state = self
            .java
            .lock()
            .map_err(|_| "Java service process state is poisoned".to_string())?;
        if state.generation != generation || state.state != JavaServiceState::Starting {
            return Err("Java service start was superseded".to_string());
        }
        state.state = JavaServiceState::Running;
        state.error = None;
        Ok(())
    }

    fn set_java_error_for_generation(&self, port: u16, generation: u64, error: impl Into<String>) {
        let Ok(mut state) = self.java.lock() else {
            return;
        };
        if state.generation != generation {
            return;
        }
        state.port = port;
        if let Some(mut child) = state.child.take() {
            terminate_child(&mut child);
        }
        state.state = JavaServiceState::Error;
        state.error = Some(error.into());
    }

    fn stop_java(&self) {
        let Ok(mut state) = self.java.lock() else {
            return;
        };
        if let Some(mut child) = state.child.take() {
            terminate_child(&mut child);
        }
        state.generation = state.generation.wrapping_add(1);
        state.state = JavaServiceState::Stopped;
        state.error = None;
    }

    fn shutdown_children(&self) {
        self.stop();
        self.stop_java();
    }

    fn java_status(&self) -> JavaServiceStatus {
        let Ok(mut state) = self.java.lock() else {
            return JavaServiceStatus {
                state: JavaServiceState::Error,
                port: DEFAULT_JAVA_MCP_PORT,
                url: java_service_url_for_port(DEFAULT_JAVA_MCP_PORT),
                error: Some("Java service process state is poisoned".to_string()),
            };
        };

        let current_state = if state.state == JavaServiceState::Starting {
            JavaServiceState::Starting
        } else {
            match state.child.as_mut().map(Child::try_wait) {
                None => {
                    if state.error.is_some() {
                        JavaServiceState::Error
                    } else {
                        JavaServiceState::Stopped
                    }
                }
                Some(Ok(None)) => JavaServiceState::Running,
                Some(Ok(Some(exit_status))) => {
                    state.child.take();
                    if exit_status.success() {
                        state.error = None;
                        state.state = JavaServiceState::Stopped;
                        JavaServiceState::Stopped
                    } else {
                        state.error = Some(format!("Java MCP exited with status {exit_status}"));
                        state.state = JavaServiceState::Error;
                        JavaServiceState::Error
                    }
                }
                Some(Err(error)) => {
                    state.child.take();
                    state.error = Some(format!("Unable to inspect Java MCP process: {error}"));
                    state.state = JavaServiceState::Error;
                    JavaServiceState::Error
                }
            }
        };

        JavaServiceStatus {
            state: current_state,
            port: state.port,
            url: java_service_url_for_port(state.port),
            error: state.error.clone(),
        }
    }

    #[cfg(test)]
    fn install_java_for_test(&self, child: Child, port: u16) {
        self.install_java(child, port)
            .expect("install test Java child");
    }

    #[cfg(test)]
    fn begin_java_start_for_test(&self, port: u16) {
        self.begin_java_start(port)
            .expect("begin test Java startup");
    }
}

impl Drop for BackendState {
    fn drop(&mut self) {
        self.shutdown_children();
    }
}

pub fn backend_url_for_port(port: u16) -> String {
    format!("http://{JAVA_MCP_HOST}:{port}")
}

pub fn java_service_url_for_port(port: u16) -> String {
    format!("http://{JAVA_MCP_HOST}:{port}/mcp")
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

fn validate_java_port(port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("Java MCP port must be between 1 and 65535".to_string());
    }
    Ok(())
}

fn java_resource_dir(debug: bool, project_root: &Path, resource_dir: &Path) -> PathBuf {
    if debug {
        project_root.join("src-tauri").join("resources")
    } else {
        resource_dir.to_path_buf()
    }
}

fn java_command_spec(
    debug: bool,
    project_root: &Path,
    resource_dir: &Path,
    port: u16,
    config_path: &Path,
) -> Result<JavaCommandSpec, String> {
    validate_java_port(port)?;
    let resource_root = java_resource_dir(debug, project_root, resource_dir);
    let java_program = resource_root
        .join("java-runtime")
        .join("bin")
        .join(if cfg!(windows) { "javaw.exe" } else { "java" });
    let config_path = config_path.to_string_lossy().to_string();
    Ok(JavaCommandSpec {
        program: java_program,
        args: vec![
            "-jar".to_string(),
            "java/mall-system.jar".to_string(),
            format!("--server.address={JAVA_MCP_HOST}"),
            format!("--server.port={port}"),
        ],
        current_dir: resource_root,
        env: vec![
            ("MALLAGENT_CONFIG_PATH".to_string(), config_path.clone()),
            ("MALLSYSTEM_DB_PATH".to_string(), config_path),
        ],
    })
}

fn normalized_config_path(path: PathBuf) -> PathBuf {
    if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        path.with_extension("db")
    } else {
        path
    }
}

fn shared_config_path() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("MALLAGENT_CONFIG_PATH") {
        let path = PathBuf::from(path);
        if !path.as_os_str().is_empty() {
            return Ok(normalized_config_path(path));
        }
    }

    #[cfg(windows)]
    let base = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("USERPROFILE").map(|path| PathBuf::from(path).join("AppData").join("Local"))
        })
        .ok_or_else(|| {
            "Unable to resolve the Windows local application data directory".to_string()
        })?;

    #[cfg(target_os = "macos")]
    let base = env::var_os("HOME")
        .map(|path| {
            PathBuf::from(path)
                .join("Library")
                .join("Application Support")
        })
        .ok_or_else(|| "Unable to resolve the macOS home directory".to_string())?;

    #[cfg(all(unix, not(target_os = "macos")))]
    let base = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|path| PathBuf::from(path).join(".config")))
        .ok_or_else(|| "Unable to resolve the user config directory".to_string())?;

    Ok(base.join("MallAgent").join("MallAgent").join("config.db"))
}

fn prepare_shared_config_path() -> Result<PathBuf, String> {
    let path = shared_config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Unable to create MallAgent config directory: {error}"))?;
    }
    Ok(path)
}

fn available_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

fn ensure_java_port_available(port: u16) -> Result<(), String> {
    validate_java_port(port)?;
    TcpListener::bind((JAVA_MCP_HOST, port))
        .map(|listener| drop(listener))
        .map_err(|_| {
            format!(
                "Java MCP port {port} is already in use on {JAVA_MCP_HOST}. Stop the other MallAgent/Java service or choose another port."
            )
        })
}

fn java_health_response_is_ready(response: &[u8]) -> bool {
    let Some(first_line) = response.split(|byte| *byte == b'\n').next() else {
        return false;
    };
    String::from_utf8_lossy(first_line)
        .split_whitespace()
        .nth(1)
        == Some("200")
}

fn wait_for_java_health(state: &BackendState, generation: u64, port: u16) -> Result<(), String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = Instant::now() + JAVA_READINESS_TIMEOUT;
    let mut last_error = "health endpoint did not respond".to_string();

    while Instant::now() < deadline {
        match state.poll_java_start(generation)? {
            Some(status) => {
                return Err(format!(
                    "Java MCP exited before becoming ready with status {status}"
                ));
            }
            None => {}
        }

        match TcpStream::connect_timeout(&address, JAVA_READINESS_PROBE_TIMEOUT) {
            Ok(mut stream) => {
                let _ = stream.set_read_timeout(Some(JAVA_READINESS_PROBE_TIMEOUT));
                let _ = stream.set_write_timeout(Some(JAVA_READINESS_PROBE_TIMEOUT));
                let request = format!(
                    "GET /actuator/health HTTP/1.1\r\nHost: {JAVA_MCP_HOST}:{port}\r\nConnection: close\r\n\r\n"
                );
                let mut response = [0_u8; 1024];
                match stream
                    .write_all(request.as_bytes())
                    .and_then(|_| stream.read(&mut response))
                {
                    Ok(size) if java_health_response_is_ready(&response[..size]) => return Ok(()),
                    Ok(size) => {
                        let response_text = String::from_utf8_lossy(&response[..size]);
                        let status_line = response_text.lines().next().unwrap_or("empty response");
                        last_error = format!("health returned {status_line}");
                    }
                    Err(error) => last_error = error.to_string(),
                }
            }
            Err(error) => last_error = error.to_string(),
        }

        thread::sleep(JAVA_READINESS_POLL_INTERVAL);
    }

    Err(format!(
        "Java MCP did not become ready on {JAVA_MCP_HOST}:{port} within {} seconds ({last_error})",
        JAVA_READINESS_TIMEOUT.as_secs()
    ))
}

fn spawn_background_task<F>(task: F) -> thread::JoinHandle<()>
where
    F: FnOnce() + Send + 'static,
{
    thread::spawn(task)
}

fn project_root_path() -> Result<PathBuf, String> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| "Unable to resolve MallAgent project root".to_string())
        .map(Path::to_path_buf)
}

fn spawn_backend(app: &AppHandle, port: u16) -> Result<Child, Box<dyn std::error::Error>> {
    let project_root = project_root_path().map_err(std::io::Error::other)?;
    let resource_dir = app.path().resource_dir()?;
    let spec = backend_command_spec(cfg!(debug_assertions), &project_root, &resource_dir, port);
    let config_path = prepare_shared_config_path().map_err(std::io::Error::other)?;
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .current_dir(&spec.current_dir)
        .env("MALLAGENT_CONFIG_PATH", &config_path)
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

fn spawn_java_service(
    app: &AppHandle,
    state: &BackendState,
    port: u16,
) -> Result<JavaServiceStatus, String> {
    validate_java_port(port)?;
    let generation = state.begin_java_start(port)?;
    let result: Result<JavaServiceStatus, String> = (|| -> Result<JavaServiceStatus, String> {
        ensure_java_port_available(port)?;
        let project_root = project_root_path()?;
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|error| format!("Unable to resolve MallAgent resource directory: {error}"))?;
        let config_path = prepare_shared_config_path()?;
        let spec = java_command_spec(
            cfg!(debug_assertions),
            &project_root,
            &resource_dir,
            port,
            &config_path,
        )?;
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .current_dir(&spec.current_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for (key, value) in &spec.env {
            command.env(key, value);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let child = command
            .spawn()
            .map_err(|error| format!("Unable to start Java MCP: {error}"))?;
        state.install_java_starting(child, port, generation)?;
        wait_for_java_health(state, generation, port)?;
        state.mark_java_running(generation)?;
        Ok(state.java_status())
    })();
    if let Err(error) = &result {
        state.set_java_error_for_generation(port, generation, error.clone());
    }
    result
}

#[tauri::command]
fn backend_url(state: State<'_, BackendState>) -> String {
    backend_url_for_port(state.port)
}

#[tauri::command]
fn java_service_status(state: State<'_, BackendState>) -> JavaServiceStatus {
    state.java_status()
}

#[tauri::command]
fn start_java_service(
    app: AppHandle,
    state: State<'_, BackendState>,
    port: u16,
) -> Result<JavaServiceStatus, String> {
    spawn_java_service(&app, state.inner(), port)
}

#[tauri::command]
fn stop_java_service(state: State<'_, BackendState>) -> JavaServiceStatus {
    state.stop_java();
    state.java_status()
}

#[tauri::command]
fn restart_java_service(
    app: AppHandle,
    state: State<'_, BackendState>,
    port: u16,
) -> Result<JavaServiceStatus, String> {
    state.stop_java();
    spawn_java_service(&app, state.inner(), port)
}

pub fn run() {
    let port = available_port().unwrap_or(FALLBACK_PORT);
    tauri::Builder::default()
        .manage(BackendState::new(port))
        .setup(move |app| {
            let child = spawn_backend(app.handle(), port)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            app.state::<BackendState>()
                .install(child)
                .map_err(std::io::Error::other)?;
            let app_handle = app.handle().clone();
            spawn_background_task(move || {
                let state = app_handle.state::<BackendState>();
                let _ = spawn_java_service(&app_handle, state.inner(), DEFAULT_JAVA_MCP_PORT);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_url,
            java_service_status,
            start_java_service,
            stop_java_service,
            restart_java_service
        ])
        .build(tauri::generate_context!())
        .expect("error while building MallAgent")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<BackendState>().shutdown_children();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{
        backend_command_spec, backend_url_for_port, ensure_java_port_available, java_command_spec,
        java_health_response_is_ready, java_service_url_for_port, spawn_background_task,
        BackendState, JavaServiceState, DEFAULT_JAVA_MCP_PORT,
    };
    use std::net::TcpListener;
    use std::path::Path;
    use std::process::Command;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[test]
    fn background_startup_dispatch_does_not_wait_for_java_readiness() {
        let (started_sender, started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let started_at = Instant::now();

        let handle = spawn_background_task(move || {
            started_sender.send(()).expect("report background startup");
            release_receiver.recv().expect("wait for test release");
        });

        started_receiver
            .recv_timeout(Duration::from_millis(250))
            .expect("background startup should begin without blocking the caller");
        assert!(
            started_at.elapsed() < Duration::from_secs(1),
            "dispatch unexpectedly waited for startup work"
        );

        release_sender.send(()).expect("release background startup");
        handle.join().expect("background startup should finish");
    }

    #[test]
    fn java_starting_state_is_visible_before_health_check_finishes() {
        let state = BackendState::new(45831);
        state.begin_java_start_for_test(DEFAULT_JAVA_MCP_PORT);

        let status = state.java_status();

        assert_eq!(status.state, JavaServiceState::Starting);
        assert_eq!(status.port, DEFAULT_JAVA_MCP_PORT);
        assert_eq!(status.error, None);
    }

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

        let executable = if cfg!(windows) {
            "mallagent-backend.exe"
        } else {
            "mallagent-backend"
        };
        assert_eq!(
            spec.program,
            Path::new("C:/resources").join("backend").join(executable)
        );
        assert_eq!(
            spec.args,
            ["--host", "127.0.0.1", "--port", "40123"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
        assert_eq!(spec.current_dir, Path::new("C:/resources"));
    }

    #[test]
    fn default_java_service_uses_loopback_and_default_port() {
        assert_eq!(DEFAULT_JAVA_MCP_PORT, 9991);
        assert_eq!(
            java_service_url_for_port(DEFAULT_JAVA_MCP_PORT),
            "http://127.0.0.1:9991/mcp"
        );
    }

    #[test]
    fn java_readiness_requires_an_http_200_health_response() {
        assert!(java_health_response_is_ready(
            b"HTTP/1.1 200\r\nContent-Length: 2\r\n\r\nok"
        ));
        assert!(!java_health_response_is_ready(
            b"HTTP/1.1 503\r\nContent-Length: 0\r\n\r\n"
        ));
        assert!(!java_health_response_is_ready(b"not an http response"));
    }

    #[test]
    fn debug_java_command_uses_project_resources_and_shared_database() {
        let spec = java_command_spec(
            true,
            Path::new("C:/project"),
            Path::new("C:/resources"),
            DEFAULT_JAVA_MCP_PORT,
            Path::new("C:/data/config.db"),
        )
        .expect("valid Java command spec");

        assert!(spec
            .program
            .ends_with("project/src-tauri/resources/java-runtime/bin/javaw.exe"));
        assert_eq!(spec.args[0], "-jar");
        assert_eq!(spec.args[1], "java/mall-system.jar");
        assert!(spec
            .args
            .contains(&"--server.address=127.0.0.1".to_string()));
        assert!(spec.args.contains(&"--server.port=9991".to_string()));
        assert_eq!(
            spec.current_dir,
            Path::new("C:/project/src-tauri/resources")
        );
        assert_eq!(
            spec.env,
            vec![
                (
                    "MALLAGENT_CONFIG_PATH".to_string(),
                    "C:/data/config.db".to_string()
                ),
                (
                    "MALLSYSTEM_DB_PATH".to_string(),
                    "C:/data/config.db".to_string()
                ),
            ]
        );
    }

    #[test]
    fn release_java_command_uses_packaged_resources() {
        let spec = java_command_spec(
            false,
            Path::new("C:/project"),
            Path::new("C:/resources"),
            40123,
            Path::new("C:/data/config.db"),
        )
        .expect("valid Java command spec");

        assert!(spec
            .program
            .ends_with("resources/java-runtime/bin/javaw.exe"));
        assert_eq!(spec.args[1], "java/mall-system.jar");
        assert_eq!(spec.current_dir, Path::new("C:/resources"));
    }

    #[test]
    fn java_command_rejects_invalid_port() {
        let error = java_command_spec(
            true,
            Path::new("C:/project"),
            Path::new("C:/resources"),
            0,
            Path::new("C:/data/config.db"),
        )
        .expect_err("port zero must be rejected");

        assert!(error.contains("between 1 and 65535"));
    }

    #[test]
    fn occupied_java_port_is_reported_before_starting_a_second_service() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("reserve a test port");
        let port = listener.local_addr().expect("read test port").port();

        let error = ensure_java_port_available(port).expect_err("occupied port must be rejected");

        assert!(error.contains(&port.to_string()));
        assert!(error.contains("already in use"));
    }

    #[test]
    fn shutdown_children_releases_backend_and_java_process_state() {
        let backend = long_running_test_child();
        let java = long_running_test_child();
        let backend_pid = backend.id();
        let java_pid = java.id();
        let state = BackendState::new(45831);
        state.install(backend).expect("install test backend child");
        state.install_java_for_test(java, DEFAULT_JAVA_MCP_PORT);

        state.shutdown_children();

        assert!(!test_process_is_running(backend_pid));
        assert!(!test_process_is_running(java_pid));
        assert!(state.child.lock().expect("backend state lock").is_none());
        assert!(state.java.lock().expect("Java state lock").child.is_none());
    }

    fn long_running_test_child() -> std::process::Child {
        if cfg!(windows) {
            Command::new("ping").args(["127.0.0.1", "-n", "30"]).spawn()
        } else {
            Command::new("sleep").arg("30").spawn()
        }
        .expect("spawn long-running test child")
    }

    fn test_process_is_running(pid: u32) -> bool {
        if cfg!(windows) {
            let output = Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH"])
                .output()
                .expect("query Windows process list");
            let pid_text = pid.to_string();
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(|line| line.split_whitespace().any(|column| column == pid_text))
        } else {
            Command::new("kill")
                .args(["-0", &pid.to_string()])
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        }
    }

    #[test]
    fn exited_java_child_is_reported_as_stopped() {
        let child = if cfg!(windows) {
            Command::new("cmd").args(["/C", "exit", "0"]).spawn()
        } else {
            Command::new("sh").args(["-c", "exit 0"]).spawn()
        }
        .expect("spawn test child");
        let state = BackendState::new(45831);
        state.install_java_for_test(child, DEFAULT_JAVA_MCP_PORT);

        for _ in 0..50 {
            let status = state.java_status();
            if status.state != JavaServiceState::Running {
                assert_eq!(status.state, JavaServiceState::Stopped);
                assert_eq!(status.error, None);
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("test Java child did not exit");
    }
}
