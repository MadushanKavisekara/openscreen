// electron-builder afterPack hook: opt-in macOS Liquid Glass app icon.
//
// A .icns only ever carries flat bitmaps, so the Dock can't re-render it for the
// dark / clear / tinted appearance modes in macOS 26. For that, macOS needs the icon
// as a compiled asset catalog (Assets.car) plus CFBundleIconName in Info.plist —
// exactly how an Xcode-built app ships it. That compile step is `actool`, which is
// only in full Xcode, not the Command Line Tools.
//
// So this hook is entirely best-effort:
//   - no icons/source/AppIcon.icon        -> skip
//   - no actool (Command Line Tools only) -> skip with a note
//   - actool present but fails            -> warn, keep going
// In every skip path the build still succeeds and macOS falls back to
// icons/generated/mac/icon.icns, which stays wired up as mac.icon. Nothing here is
// load-bearing; it only ever upgrades the icon.
//
// Runs before code signing, so anything written into the bundle gets signed with it.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ICON_ASSET_NAME = "AppIcon";
const REPO_ROOT = path.join(__dirname, "..");
const ICON_SOURCE = path.join(REPO_ROOT, "icons", "source", `${ICON_ASSET_NAME}.icon`);

function findActool() {
	try {
		return execFileSync("xcrun", ["--find", "actool"], {
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim();
	} catch {
		return null;
	}
}

/** Keys actool decided the bundle needs (CFBundleIconName and friends). */
function readPartialPlist(plistPath) {
	if (!fs.existsSync(plistPath)) {
		return {};
	}
	const json = execFileSync("plutil", ["-convert", "json", "-o", "-", plistPath], {
		stdio: ["ignore", "pipe", "pipe"],
	}).toString();
	return JSON.parse(json);
}

function setPlistString(plistPath, key, value) {
	// Set fails when the key is absent and Add fails when it's present, so try both.
	for (const command of [`Set :${key} ${value}`, `Add :${key} string ${value}`]) {
		try {
			execFileSync("/usr/libexec/PlistBuddy", ["-c", command, plistPath], {
				stdio: "ignore",
			});
			return;
		} catch {
			// fall through to the other operation
		}
	}
	throw new Error(`could not set ${key} in ${path.basename(plistPath)}`);
}

exports.default = async function afterPackIcon(context) {
	if (context.electronPlatformName !== "darwin") {
		return;
	}

	if (!fs.existsSync(ICON_SOURCE)) {
		return;
	}

	const actool = findActool();
	if (!actool) {
		console.log(
			"after-pack-icon: actool not found (full Xcode required) — shipping the static .icns icon.",
		);
		return;
	}

	const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
	const resourcesDir = path.join(appPath, "Contents", "Resources");
	const infoPlist = path.join(appPath, "Contents", "Info.plist");
	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-appicon-"));

	try {
		const compiledDir = path.join(workDir, "compiled");
		const partialPlist = path.join(workDir, "partial.plist");
		fs.mkdirSync(compiledDir, { recursive: true });

		execFileSync(
			actool,
			[
				"--output-format",
				"human-readable-text",
				"--warnings",
				"--errors",
				"--platform",
				"macosx",
				"--target-device",
				"mac",
				// Liquid Glass icon rendering is macOS 26+; older systems use the .icns.
				"--minimum-deployment-target",
				"26.0",
				"--app-icon",
				ICON_ASSET_NAME,
				"--include-all-app-icons",
				"--output-partial-info-plist",
				partialPlist,
				"--compile",
				compiledDir,
				ICON_SOURCE,
			],
			{ stdio: ["ignore", "inherit", "inherit"] },
		);

		const assetsCar = path.join(compiledDir, "Assets.car");
		if (!fs.existsSync(assetsCar)) {
			throw new Error("actool reported success but produced no Assets.car");
		}

		fs.copyFileSync(assetsCar, path.join(resourcesDir, "Assets.car"));

		// CFBundleIconName is what points the Dock at the catalog entry. CFBundleIconFile
		// is deliberately left alone so pre-26 systems still resolve icon.icns.
		const emitted = readPartialPlist(partialPlist);
		setPlistString(infoPlist, "CFBundleIconName", emitted.CFBundleIconName ?? ICON_ASSET_NAME);

		console.log(`after-pack-icon: compiled ${path.basename(ICON_SOURCE)} into Assets.car.`);
	} catch (error) {
		console.warn(
			`after-pack-icon: could not compile ${path.basename(ICON_SOURCE)} ` +
				`(${error.message}) — falling back to the static .icns icon.`,
		);
	} finally {
		fs.rmSync(workDir, { recursive: true, force: true });
	}
};
