use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::{self, Command};

const ERR_PARITY_BRIDGE_MISSING: &str = "ERR_PARITY_BRIDGE_MISSING";

fn package_root_from_current_exe() -> PathBuf {
    let exe_path = env::current_exe().expect("current exe path");
    exe_path
        .parent()
        .and_then(|path| path.parent())
        .and_then(|path| path.parent())
        .expect("package root")
        .to_path_buf()
}

fn ancestors_from(start: PathBuf) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut current = Some(start.as_path());
    while let Some(path) = current {
        out.push(path.to_path_buf());
        current = path.parent();
    }
    out
}

fn find_bridge_and_node(package_root: &PathBuf) -> Result<(String, Vec<String>), String> {
    let package_bridge = package_root.join("app").join("audit").join("run_rust_parity_bridge.js");
    let package_node = package_root
        .join("bin")
        .join("node")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    if package_bridge.is_file() && package_node.is_file() {
        return Ok((package_node.to_string_lossy().to_string(), vec![package_bridge.to_string_lossy().to_string()]));
    }

    let mut roots = ancestors_from(env::current_exe().map_err(|error| error.to_string())?);
    if let Ok(cwd) = env::current_dir() {
        roots.extend(ancestors_from(cwd));
    }
    roots.push(package_root.clone());

    for root in roots {
        let ts_bridge = root.join("audit").join("run_rust_parity_bridge.ts");
        if ts_bridge.is_file() {
            return Ok((
                "node".to_string(),
                vec![
                    "--experimental-strip-types".to_string(),
                    ts_bridge.to_string_lossy().to_string(),
                ],
            ));
        }
        let js_bridge = root.join("app").join("audit").join("run_rust_parity_bridge.js");
        let node = root
            .join("bin")
            .join("node")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        if js_bridge.is_file() && node.is_file() {
            return Ok((node.to_string_lossy().to_string(), vec![js_bridge.to_string_lossy().to_string()]));
        }
    }

    Err(ERR_PARITY_BRIDGE_MISSING.to_string())
}

fn print_version(package_root: &PathBuf) {
    let provenance_path = package_root.join("provenance.json");
    let provenance = fs::read_to_string(&provenance_path)
        .unwrap_or_else(|_| "{\"error\":\"missing provenance.json\"}".to_string());
    println!("{provenance}");
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let package_root = package_root_from_current_exe();

    if args.len() == 2 && (args[1] == "--version" || args[1] == "version") {
        print_version(&package_root);
        return;
    }

    if args.len() != 2 {
        eprintln!("usage: parity_runner <vector_path>\n       parity_runner --version");
        process::exit(1);
    }

    let (node_binary, mut bridge_args) = match find_bridge_and_node(&package_root) {
        Ok(resolved) => resolved,
        Err(code) => {
            eprintln!("{code}");
            process::exit(2);
        }
    };
    bridge_args.push(args[1].clone());

    let output = Command::new(node_binary)
        .args(bridge_args)
        .output()
        .unwrap_or_else(|error| {
            eprintln!("{ERR_PARITY_BRIDGE_MISSING}: {error}");
            process::exit(2);
        });

    if !output.status.success() {
        eprintln!("{}", String::from_utf8_lossy(&output.stderr));
        process::exit(output.status.code().unwrap_or(1));
    }

    print!("{}", String::from_utf8_lossy(&output.stdout));
}
