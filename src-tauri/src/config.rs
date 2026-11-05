use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 宠物显示大小档位
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PetSize {
    Small,
    Medium,
    Large,
    Xlarge,
}

impl PetSize {
    pub fn as_label(&self) -> &'static str {
        match self {
            PetSize::Small => "小",
            PetSize::Medium => "中",
            PetSize::Large => "大",
            PetSize::Xlarge => "特大",
        }
    }

    pub fn as_px(&self) -> u32 {
        match self {
            PetSize::Small => 180,
            PetSize::Medium => 240,
            PetSize::Large => 300,
            PetSize::Xlarge => 360,
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "small" => Some(PetSize::Small),
            "medium" => Some(PetSize::Medium),
            "large" => Some(PetSize::Large),
            "xlarge" => Some(PetSize::Xlarge),
            _ => None,
        }
    }
}

impl Default for PetSize {
    fn default() -> Self {
        PetSize::Small
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct AppConfig {
    #[serde(default)]
    pet_size: PetSize,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

fn read_config(app: &AppHandle) -> AppConfig {
    let path = match config_path(app) {
        Ok(p) => p,
        Err(_) => return AppConfig::default(),
    };
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_config(app: &AppHandle, cfg: &AppConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let s = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, s).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_pet_size(app: &AppHandle) -> PetSize {
    read_config(app).pet_size
}

pub fn set_pet_size(app: &AppHandle, size: PetSize) -> Result<(), String> {
    let mut cfg = read_config(app);
    cfg.pet_size = size;
    write_config(app, &cfg)
}
