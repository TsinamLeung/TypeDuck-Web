import { useState, useEffect, useRef, useCallback } from "react";

import Candidate from "./Candidate";
import CandidateInfo from "./CandidateInfo";
import CaretFollower from "./CaretFollower";
import { RIME_KEY_MAP } from "./consts";
import DictionaryPanel from "./DictionaryPanel";
import Rime, { subscribe } from "./rime";
import { isPrintable, notify } from "./utils";

import type { InputState, InterfacePreferences, RimeResult } from "./types";

export default function CandidatePanel({ runAsyncTask, textArea, prefs, deployStatus }: {
	runAsyncTask(asyncTask: () => Promise<void>): void;
	textArea: HTMLTextAreaElement;
	prefs: InterfacePreferences;
	deployStatus: number;
}) {
	const [inputState, setInputState] = useState<InputState | undefined>();
	const [showDictionaryIndex, setShowDictionaryIndex] = useState<number | undefined>();
	const candidateList = useRef<HTMLTableElement>(null);
	const dictionaryPanel = useRef<HTMLDivElement>(null);
	const composition = useRef<{ value: string; selectionStart: number; selectionEnd: number; prefix: string; base?: string; input: string } | undefined>();
	// Rime's input if it was last changed by `setInput`
	const lastInput = useRef<string | undefined>();
	const isASCIIMode = useRef(false);

	const hideDictionary = useCallback(() => {
		setShowDictionaryIndex(undefined);
	}, [setShowDictionaryIndex]);

	// Restore the textarea to how it was before the composition and return the text the keyboard inserted after the word it has passed to Rime
	const endComposition = useCallback(() => {
		if (!composition.current) return "";
		const { value, selectionStart, selectionEnd, input } = composition.current;
		composition.current = undefined;
		const inserted = getInsertedText(value, textArea.value) ?? "";
		textArea.value = value;
		textArea.selectionStart = selectionStart;
		textArea.selectionEnd = selectionEnd;
		return inserted.startsWith(input) ? inserted.slice(input.length) : inserted;
	}, [textArea]);

	const insert = useCallback((newText: string) => {
		endComposition();
		const { selectionStart, selectionEnd } = textArea;
		textArea.value = textArea.value.slice(0, selectionStart) + newText + textArea.value.slice(selectionEnd);
		textArea.selectionStart = textArea.selectionEnd = selectionStart + newText.length;
	}, [endComposition, textArea]);

	const handleRimeResult = useCallback((promise: Promise<RimeResult>, key?: string, input?: string) => {
		lastInput.current = input;
		runAsyncTask(async () => {
			let type: "warning" | "error" | undefined;
			try {
				const result = await promise;
				if (!result.success) {
					type = "warning";
				}
				const state = result.isComposing
					? {
						inputBuffer: result.inputBuffer,
						highlightedIndex: result.highlightedIndex,
						candidates: result.candidates.map(
							({ label, text, comment }, i) => new CandidateInfo(label || `${(i + 1) % 10}.`, text, comment),
						),
						isPrevDisabled: !result.page,
						isNextDisabled: result.isLastPage,
					}
					: inputState;
				if (result.committed) {
					insert(result.committed);
				}
				else if (!state && key && isPrintable(key)) {
					insert(key);
				}
				setInputState(result.isComposing ? state : undefined);
				hideDictionary();
			}
			catch {
				type = "error";
			}
			if (type) {
				notify(type, "執行操作", "performing the operation");
			}
			textArea.focus();
		});
	}, [hideDictionary, inputState, insert, runAsyncTask, textArea]);

	const processKey = useCallback((input: string, key?: string) => handleRimeResult(Rime.processKey(input), key), [handleRimeResult]);
	const setInput = useCallback((input: string) => handleRimeResult(Rime.setInput(input), undefined, input), [handleRimeResult]);
	const flipPage = useCallback((backward: boolean) => handleRimeResult(Rime.flipPage(backward)), [handleRimeResult]);
	const selectCandidate = useCallback((index: number) => handleRimeResult(Rime.selectCandidate(index)), [handleRimeResult]);
	const deleteCandidate = useCallback((index: number) => handleRimeResult(Rime.deleteCandidate(index)), [handleRimeResult]);

	const parseKey = useCallback((event: KeyboardEvent) => {
		const { code, key } = event;
		const hasControl = event.getModifierState("Control");
		const hasMeta = event.getModifierState("Meta");
		const hasAlt = event.getModifierState("Alt");
		const hasShift = event.getModifierState("Shift");
		if (
			(inputState || (
				document.activeElement === textArea
				&& (!hasControl && (isPrintable(key) || !hasShift && key === "F4") || key === "`")
				&& !hasMeta
				&& !hasAlt
			)) && code
		) {
			const match = /^(Control|Meta|Alt|Shift)(Left|Right)$/.exec(code);
			const isNumpadKey = code.startsWith("Numpad");
			const modifiers = new Set<string>();
			if (hasControl) {
				modifiers.add("Control");
			}
			if (hasMeta) {
				modifiers.add("Meta");
			}
			if (hasAlt) {
				modifiers.add("Alt");
			}
			if (hasShift) {
				modifiers.add("Shift");
			}
			if (match) {
				modifiers.delete(match[1]);
				modifiers.add(`${match[1]}_${match[2][0]}`);
			}
			else {
				let rimeKey = isNumpadKey ? code.slice(6) : key;
				rimeKey = RIME_KEY_MAP[rimeKey] || rimeKey;
				modifiers.add(isNumpadKey ? `KP_${rimeKey}` : rimeKey);
			}
			return [...modifiers].join("+");
		}
		return undefined;
	}, [inputState, textArea]);

	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			const key = parseKey(event);
			if (key) {
				event.preventDefault();
				processKey(`{${key}}`, event.key);
			}
		}
		function onKeyUp(event: KeyboardEvent) {
			if (inputState) {
				const key = parseKey(event);
				if (key) processKey(`{Release+${key}}`);
			}
		}
		document.addEventListener("keydown", onKeyDown);
		document.addEventListener("keyup", onKeyUp);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.removeEventListener("keyup", onKeyUp);
		};
	}, [inputState, parseKey, processKey]);

	useEffect(() => {
		// Android virtual keyboards (e.g. Gboard) send `keydown` events with `key: "Unidentified"` and compose words in the textarea directly,
		// so pass the composed word to Rime as its input, and take back the other characters they insert to pass them to Rime as keys
		let snapshot: { value: string; selectionStart: number; selectionEnd: number } | undefined;
		function processKeys(keys: string) {
			for (const key of keys) {
				processKey(`{${RIME_KEY_MAP[key] || key}}`, key);
			}
		}
		function onCompositionStart({ data }: CompositionEvent) {
			if (!isASCIIMode.current) {
				const { value, selectionStart, selectionEnd } = textArea;
				// The keyboard may start the composition from an existing word next to the caret.
				// If Rime's input is unknown, the composed word is passed as keys when the composition ends instead
				composition.current = { value, selectionStart, selectionEnd, prefix: data, base: lastInput.current ?? (inputState ? undefined : ""), input: "" };
			}
		}
		function onCompositionEnd() {
			processKeys(endComposition());
		}
		function onBeforeInput() {
			const { value, selectionStart, selectionEnd } = textArea;
			snapshot = { value, selectionStart, selectionEnd };
		}
		function onInput(event: Event) {
			const { inputType, data } = event as InputEvent;
			const state = snapshot;
			snapshot = undefined;
			if (inputType === "insertCompositionText") {
				const input = data?.startsWith(composition.current?.prefix ?? "") ? data.slice(composition.current?.prefix.length) : undefined;
				if (composition.current?.base !== undefined && input !== undefined && /^[a-z]*$/.test(input)) {
					composition.current.input = input;
					setInput(composition.current.base + input);
				}
				return;
			}
			if (!state || composition.current) return;
			let keys: string | undefined;
			if (inputType === "insertText") {
				const inserted = getInsertedText(state.value, textArea.value);
				if (inserted && [...inserted].every(isPrintable)) {
					keys = inserted;
				}
			}
			if (keys || inputState && (inputType === "deleteContentBackward" || inputType === "insertLineBreak")) {
				textArea.value = state.value;
				textArea.selectionStart = state.selectionStart;
				textArea.selectionEnd = state.selectionEnd;
				if (keys) {
					processKeys(keys);
				}
				else {
					processKey(inputType === "deleteContentBackward" ? "{BackSpace}" : "{Return}");
				}
			}
		}
		textArea.addEventListener("compositionstart", onCompositionStart);
		textArea.addEventListener("compositionend", onCompositionEnd);
		textArea.addEventListener("beforeinput", onBeforeInput);
		textArea.addEventListener("input", onInput);
		return () => {
			textArea.removeEventListener("compositionstart", onCompositionStart);
			textArea.removeEventListener("compositionend", onCompositionEnd);
			textArea.removeEventListener("beforeinput", onBeforeInput);
			textArea.removeEventListener("input", onInput);
		};
	}, [endComposition, inputState, processKey, setInput, textArea]);

	useEffect(() =>
		subscribe("optionChanged", (option, value) => {
			if (option === "ascii_mode") {
				isASCIIMode.current = value;
			}
		}), []);

	useEffect(() => {
		setInputState(undefined);
		lastInput.current = undefined;
		hideDictionary();
	}, [deployStatus, setInputState, hideDictionary]);

	const hideDictionaryOnLeaveCandidate = useCallback(() => {
		function hideDictionaryOnLeaveDictionaryPanel() {
			if (!candidateList.current?.matches(":hover")) {
				hideDictionary();
			}
			dictionaryPanel.current?.removeEventListener("mouseleave", hideDictionaryOnLeaveDictionaryPanel);
			dictionaryPanel.current?.removeEventListener("touchend", hideDictionaryOnLeaveDictionaryPanel);
		}
		if (dictionaryPanel.current?.matches(":hover")) {
			dictionaryPanel.current.addEventListener("mouseleave", hideDictionaryOnLeaveDictionaryPanel);
			dictionaryPanel.current.addEventListener("touchend", hideDictionaryOnLeaveDictionaryPanel);
		}
		else if (!candidateList.current?.matches(":hover")) {
			hideDictionary();
		}
	}, [hideDictionary]);

	const shouldShowDictionary = typeof showDictionaryIndex === "number";
	return inputState && <CaretFollower textArea={textArea} className="candidate-panel">
		<div>
			<div className="flex">
				<div className="flex-1 text-[15pt]">
					{inputState.inputBuffer.before && <span className="m-1 inline-block">{inputState.inputBuffer.before}</span>}
					{inputState.inputBuffer.active && <span className="p-1 inline-block rounded-md bg-accent text-accent-content">{inputState.inputBuffer.active}</span>}
					{inputState.inputBuffer.after && <span className="m-1 inline-block">{inputState.inputBuffer.after}</span>}
				</div>
				<div className="join">
					<button className="page-nav join-item" disabled={inputState.isPrevDisabled} onClick={() => flipPage(true)}>
						<span className="relative bottom-1">‹</span>
					</button>
					<button className="page-nav join-item" disabled={inputState.isNextDisabled} onClick={() => flipPage(false)}>
						<span className="relative bottom-1">›</span>
					</button>
				</div>
			</div>
			<table ref={candidateList} className="candidates">
				{inputState.candidates.map((candidate, index) =>
					<Candidate
						key={index}
						info={candidate}
						isHighlighted={index === (shouldShowDictionary ? showDictionaryIndex : inputState.highlightedIndex)}
						selectCandidate={() => selectCandidate(index)}
						deleteCandidate={() => deleteCandidate(index)}
						showDictionary={() => setShowDictionaryIndex(index)}
						hideDictionary={hideDictionaryOnLeaveCandidate}
						prefs={prefs} />
				)}
			</table>
		</div>
		{shouldShowDictionary && <DictionaryPanel info={inputState.candidates[showDictionaryIndex]} prefs={prefs} ref={dictionaryPanel} />}
	</CaretFollower>;
}

// Return the text inserted into `oldValue` to make `newValue`, or `undefined` if anything was removed
function getInsertedText(oldValue: string, newValue: string) {
	let prefix = 0;
	while (prefix < oldValue.length && oldValue[prefix] === newValue[prefix]) prefix++;
	let suffix = 0;
	while (suffix < oldValue.length - prefix && oldValue[oldValue.length - 1 - suffix] === newValue[newValue.length - 1 - suffix]) suffix++;
	return prefix + suffix === oldValue.length ? newValue.slice(prefix, newValue.length - suffix) : undefined;
}
