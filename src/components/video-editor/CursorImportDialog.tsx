import { AlertTriangle, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useScopedT } from "@/contexts/I18nContext";
import {
	buildCursorPack,
	type CursorImportResult,
	type ImportedCursorFile,
	readCursorImport,
} from "@/lib/cursor/cursorImport";
import { ASSIGNABLE_CURSOR_ROLES } from "@/lib/cursor/cursorRoleMapping";
import { addCustomCursorPack, type CustomCursorPack } from "@/lib/cursor/customCursors";
import { cn } from "@/lib/utils";
import type { NativeCursorType } from "@/native/contracts";

/** Sentinel for "no role" — Radix Select cannot hold an empty string value. */
const UNASSIGNED = "__unassigned__";

interface CursorImportDialogProps {
	/** Files chosen by the user; the dialog reads them when it opens. */
	files: File[] | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onImported: (pack: CustomCursorPack) => void;
}

/**
 * Confirms how an imported cursor pack maps onto the editor's cursor roles.
 *
 * Roles are guessed from file names, which is a convention packs follow loosely, so every
 * guess is shown for review. A well-named set is a glance-and-accept; a badly named one
 * can be fixed here instead of silently rendering the wrong art.
 */
export function CursorImportDialog({
	files,
	open,
	onOpenChange,
	onImported,
}: CursorImportDialogProps) {
	const t = useScopedT("settings");
	const tc = useScopedT("common");
	const [result, setResult] = useState<CursorImportResult | null>(null);
	const [entries, setEntries] = useState<ImportedCursorFile[]>([]);
	const [name, setName] = useState("");
	const [reading, setReading] = useState(false);
	const [saving, setSaving] = useState(false);

	const roleLabel = useCallback((role: NativeCursorType) => t(`cursor.roles.${role}`), [t]);

	useEffect(() => {
		if (!open || !files || files.length === 0) {
			return;
		}

		let cancelled = false;
		setReading(true);
		setResult(null);
		setEntries([]);

		readCursorImport(files)
			.then((imported) => {
				if (cancelled) {
					return;
				}
				setResult(imported);
				setEntries(imported.files);
				setName(imported.suggestedName);
			})
			.catch((error) => {
				if (cancelled) {
					return;
				}
				console.error("Failed to read cursor import:", error);
				toast.error(t("cursor.import.errorRead"));
				onOpenChange(false);
			})
			.finally(() => {
				if (!cancelled) {
					setReading(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [open, files, t, onOpenChange]);

	/** A role may only be held by one file, so taking it releases the previous holder. */
	const assignRole = (index: number, role: NativeCursorType | null) => {
		setEntries((previous) =>
			previous.map((entry, entryIndex) => {
				if (entryIndex === index) {
					return { ...entry, role };
				}
				if (role && entry.role === role) {
					return { ...entry, role: null };
				}
				return entry;
			}),
		);
	};

	const assignedCount = useMemo(() => entries.filter((entry) => entry.role).length, [entries]);

	const handleImport = async () => {
		if (assignedCount === 0) {
			toast.error(t("cursor.import.noneAssigned"));
			return;
		}

		setSaving(true);
		try {
			const pack = await buildCursorPack(name, entries);
			const added = addCustomCursorPack(pack);

			if (!added.ok) {
				const message =
					added.reason === "too-many"
						? t("cursor.import.errorTooMany")
						: added.reason === "too-large"
							? t("cursor.import.errorTooLarge")
							: t("cursor.import.errorStorage");
				toast.error(message);
				return;
			}

			if (added.alreadyPresent) {
				toast.info(t("cursor.import.alreadyPresent", { name: added.pack.name }));
			} else {
				toast.success(t("cursor.import.success", { name: added.pack.name }));
			}

			onImported(added.pack);
			onOpenChange(false);
		} catch (error) {
			console.error("Failed to save cursor pack:", error);
			toast.error(t("cursor.import.errorStorage"));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="bg-[#1a1a1c] border-white/10 text-slate-200 max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("cursor.import.title")}</DialogTitle>
					<DialogDescription className="text-slate-400">
						{t("cursor.import.description")}
					</DialogDescription>
				</DialogHeader>

				{reading ? (
					<div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400">
						<Loader2 className="w-4 h-4 animate-spin" />
						{t("cursor.import.reading")}
					</div>
				) : (
					<div className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="cursor-pack-name" className="text-slate-200">
								{t("cursor.import.nameLabel")}
							</Label>
							<Input
								id="cursor-pack-name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								placeholder={t("cursor.import.namePlaceholder")}
								className="bg-white/5 border-white/10 text-slate-200"
							/>
						</div>

						<div className="max-h-72 overflow-y-auto custom-scrollbar rounded-lg border border-white/10 divide-y divide-white/5">
							{entries.map((entry, index) => {
								const fileName = entry.path.split(/[\\/]/).pop() ?? entry.path;
								const needsReview = !entry.role || entry.confidence === "low";
								return (
									<div key={entry.path} className="flex items-center gap-3 p-2">
										<div className="w-8 h-8 shrink-0 rounded-md bg-white/5 border border-white/10 flex items-center justify-center overflow-hidden">
											<img
												src={entry.dataUrl}
												alt=""
												className="w-6 h-6 object-contain"
												draggable={false}
											/>
										</div>
										<div className="min-w-0 flex-1">
											<div className="truncate text-[11px] text-slate-300" title={fileName}>
												{fileName}
											</div>
											{needsReview && (
												<div className="flex items-center gap-1 text-[10px] text-amber-400/90">
													<AlertTriangle className="w-2.5 h-2.5 shrink-0" />
													{t("cursor.import.lowConfidence")}
												</div>
											)}
										</div>
										<Select
											value={entry.role ?? UNASSIGNED}
											onValueChange={(value) =>
												assignRole(index, value === UNASSIGNED ? null : (value as NativeCursorType))
											}
										>
											<SelectTrigger
												className={cn(
													"h-7 w-40 shrink-0 bg-white/5 border-white/10 text-[11px] text-slate-200",
													needsReview && "border-amber-400/40",
												)}
												aria-label={t("cursor.import.roleLabel", { file: fileName })}
											>
												<SelectValue />
											</SelectTrigger>
											<SelectContent className="bg-[#1a1a1c] border-white/10 text-slate-200">
												<SelectItem value={UNASSIGNED} className="text-[11px]">
													{t("cursor.import.unassigned")}
												</SelectItem>
												{ASSIGNABLE_CURSOR_ROLES.map((role) => (
													<SelectItem key={role} value={role} className="text-[11px]">
														{roleLabel(role)}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
								);
							})}
						</div>

						{result && result.skipped.length > 0 && (
							<p className="text-[10px] text-slate-500">
								{t("cursor.import.skipped", { count: result.skipped.length })}
							</p>
						)}

						<div className="flex items-center justify-between gap-2">
							<span className="text-[10px] text-slate-500">
								{t("cursor.import.assignedCount", {
									assigned: assignedCount,
									total: entries.length,
								})}
							</span>
							<div className="flex gap-2">
								<Button
									variant="outline"
									onClick={() => onOpenChange(false)}
									className="bg-white/5 border-white/10 text-slate-200 hover:bg-white/10"
								>
									{tc("actions.cancel")}
								</Button>
								<Button
									onClick={handleImport}
									disabled={saving || assignedCount === 0}
									className="bg-[#34B27B] hover:bg-[#2b9668] text-white"
								>
									{t("cursor.import.confirm")}
								</Button>
							</div>
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
