use objc2::{AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSImage};
use objc2_foundation::NSData;
use tauri::{AppHandle, Runtime, Theme};

const LIGHT: &[u8] = include_bytes!("../icons/muse-light.png");
const DARK: &[u8] = include_bytes!("../icons/muse-dark.png");

/// The Dock follows macOS appearance independently of the webview's UI theme.
pub fn update<R: Runtime>(app: &AppHandle<R>, theme: Theme) {
    let bytes = if theme == Theme::Dark {
        DARK
    } else {
        LIGHT
    };
    if let Err(error) = app.run_on_main_thread(move || {
        let Some(main) = MainThreadMarker::new() else {
            return;
        };
        let data = NSData::with_bytes(bytes);
        let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
            crate::native_log("warn", "app_icon.decode_failed", "could not decode the bundled Muse app icon");
            return;
        };
        // AppKit requires the application icon to be changed on the main thread.
        unsafe { NSApplication::sharedApplication(main).setApplicationIconImage(Some(&image)) };
    }) {
        crate::native_log("warn", "app_icon.update_skipped", &format!("app icon update skipped: {error}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_appearance_icons_decode_with_appkit() {
        for bytes in [LIGHT, DARK] {
            let data = NSData::with_bytes(bytes);
            assert!(NSImage::initWithData(NSImage::alloc(), &data).is_some(), "a bundled icon must be decodable by the Dock");
        }
    }
}
