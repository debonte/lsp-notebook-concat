// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';
import * as vscodeUri from 'vscode-uri';
import * as protocol from 'vscode-languageserver-protocol';
import * as path from 'path';
import * as shajs from 'object-hash';
import {
    findLastIndex,
    InteractiveInputScheme,
    InteractiveScheme,
    isInteractiveCell,
    PYTHON_LANGUAGE,
    splitLines
} from './common/utils';
import {
    DefaultWordPattern,
    ensureValidWordDefinition,
    getWordAtText,
    regExpLeadsToEndlessLoop
} from './common/wordHelper';
import { NotebookConcatLine } from './notebookConcatLine';
import { ITextDocument, ITextLine, RefreshNotebookEvent } from './types';
import { createPosition, createRange } from './helper';

type NotebookSpan = {
    uri: vscodeUri.URI;
    fragment: number;
    inRealCell: boolean;
    startOffset: number;
    endOffset: number;
    realOffset: number;
    realEndOffset: number;
    text: string;
    realText: string;
};

const TypeIgnoreAddition = ' # type: ignore';
const HeaderAddition = 'import IPython\nIPython.get_ipython()\n'; // Eliminate warning about not using

const TypeIgnoreTransforms = [{ regex: /(^\s*%.*)/ }, { regex: /(^\s*!.*)/ }, { regex: /(^\s*await\s+.*)/ }];

const NotebookConcatPrefix = '_NotebookConcat_';

export function getConcatDocumentRoot(cellUri: vscodeUri.URI) {
    return path.dirname(cellUri.fsPath);
}

export class NotebookConcatDocument implements ITextDocument {
    public get uri(): vscodeUri.URI {
        return this.concatUri;
    }
    public get fileName(): string {
        return this.uri.fsPath;
    }
    public get isUntitled(): boolean {
        return true;
    }
    public get languageId(): string {
        return PYTHON_LANGUAGE;
    }
    public get version(): number {
        return this._version;
    }
    public get isDirty(): boolean {
        return true;
    }
    public get isClosed(): boolean {
        return this._closed;
    }
    public get isOpen() {
        return !this.isClosed;
    }
    public get eol(): number {
        return 1;
    }
    public get notebook(): any {
        return undefined;
    }
    public get lineCount(): number {
        return this._lines.length;
    }
    public get concatUri(): vscodeUri.URI {
        return this._concatUri || vscodeUri.URI.parse('');
    }
    public get notebookUri(): vscodeUri.URI {
        return this._notebookUri || vscodeUri.URI.parse('');
    }

    private _interactiveWindow = false;
    private _concatUri: vscodeUri.URI | undefined;
    private _notebookUri: vscodeUri.URI | undefined;
    private _version = 1;
    private _closed = true;
    private _spans: NotebookSpan[] = [];
    private _lines: NotebookConcatLine[] = [];
    private _realLines: NotebookConcatLine[] = [];

    constructor(
        public key: string,
        private readonly getNotebookHeader: (uri: vscodeUri.URI) => string,
        private readonly _disableTypeIgnore = false
    ) {}

    // Handles changes in the real cells and maps them to changes in the concat document.
    // This log expression is useful for debugging
    // >>> Changes from edit {JSON.stringify(edit)} and {JSON.stringify(oldText)} to {JSON.stringify(newText)} with diff {JSON.stringify(diff)} and changes {JSON.stringify(changes)}
    public handleChange(e: protocol.DidChangeTextDocumentParams): protocol.DidChangeTextDocumentParams | undefined {
        this._version++;
        const changes: protocol.TextDocumentContentChangeEvent[] = [];
        const index = this._spans.findIndex((c) => c.uri.toString() === e.textDocument.uri);
        if (index >= 0) {
            e.contentChanges.forEach((edit) => {
                try {
                    // Get old text for diffing
                    const oldSpans = this._spans.filter((s) => s.uri.toString() === e.textDocument.uri);
                    const oldCellLines = this._lines.filter((l) => l.cellUri.toString() === e.textDocument.uri);

                    // Apply the edit to the real spans
                    const editText = edit.text.replace(/\r/g, '');
                    const editRange =
                        'range' in edit ? edit.range : createRange(createPosition(0, 0), createPosition(0, 0));
                    const realText = this.getRealText(oldSpans[0].uri);
                    const realCellLines = this._realLines.filter((r) => r.cellUri.toString() === e.textDocument.uri);
                    const firstLineOffset = realCellLines[0].offset;
                    const startOffset =
                        realCellLines[editRange.start.line].offset + editRange.start.character - firstLineOffset;
                    const endOffset =
                        realCellLines[editRange.end.line].offset + editRange.end.character - firstLineOffset;
                    const editedText = `${realText.slice(0, startOffset)}${editText}${realText.slice(endOffset)}`;

                    // Create new spans from the edited text
                    const newSpans = this.createSpans(
                        oldSpans[0].uri,
                        editedText,
                        oldSpans[0].startOffset,
                        oldSpans[0].realOffset
                    );
                    const newText = newSpans.map((s) => s.text).join('');

                    // If new spans or old spans have non line spanning fakes (meaning chars in the middle of a line)
                    // just do a complete change for the whole cell
                    const oldSpansWithFakes = oldSpans.find((s) => !s.inRealCell && !s.text.endsWith('\n'));
                    const newSpansWithFakes = newSpans.find((s) => !s.inRealCell && !s.text.endsWith('\n'));

                    // If no spans that might need partial edits, then translate the edit.
                    if (!oldSpansWithFakes && !newSpansWithFakes && newSpans.length == oldSpans.length) {
                        // Concat line should line up with real line. Just find its corresponding line
                        const oldTextStart = this.mapRealToConcatOffset(startOffset + firstLineOffset);
                        const oldTextEnd = this.mapRealToConcatOffset(endOffset + firstLineOffset);

                        const oldStartLine = oldCellLines.find(
                            (l) => oldTextStart >= l.offset && oldTextStart < l.endOffset
                        );
                        const oldEndLine = oldCellLines.find((l) => oldTextEnd >= l.offset && oldTextEnd < l.endOffset);

                        // Characters should match because there are no 'partial' lines in this cell
                        const fromPosition = createPosition(
                            oldStartLine?.lineNumber || editRange.start.line,
                            editRange.start.character
                        );
                        const toPosition = createPosition(
                            oldEndLine?.lineNumber || editRange.end.line,
                            editRange.end.character
                        );

                        changes.push({
                            text: editText,
                            range: this.createSerializableRange(fromPosition, toPosition),
                            rangeLength: oldTextEnd - oldTextStart
                        } as any);
                    } else {
                        // Just say the whole thing changed. Much simpler than trying to compute
                        // a new diff. This should be the odd ball case.
                        // DEBT: Could try using the fast-myers-diff again. Problem was with deletes across multiple lines.
                        const fromPosition = oldCellLines[0].range.start;
                        const toPosition = {
                            line: oldCellLines.length + oldCellLines[0].range.start.line,
                            character: 0
                        };

                        changes.push({
                            text: newText,
                            range: this.createSerializableRange(fromPosition, toPosition),
                            rangeLength: oldCellLines[oldCellLines.length - 1].endOffset + 1 - oldCellLines[0].offset
                        } as any);
                    }

                    // Finally update our spans for this cell.
                    const concatDiffLength =
                        newSpans[newSpans.length - 1].endOffset - oldSpans[oldSpans.length - 1].endOffset;
                    const realDiffLength =
                        newSpans[newSpans.length - 1].realEndOffset - oldSpans[oldSpans.length - 1].realEndOffset;
                    this._spans.splice(index, oldSpans.length, ...newSpans);
                    for (let i = index + newSpans.length; i < this._spans.length; i++) {
                        this._spans[i].startOffset += concatDiffLength;
                        this._spans[i].endOffset += concatDiffLength;
                        this._spans[i].realOffset += realDiffLength;
                        this._spans[i].realEndOffset += realDiffLength;
                    }

                    // Recreate our lines
                    this.computeLines();
                } catch (e) {
                    console.log(`Concat document failure : ${e}`);
                }
            });
            return this.toDidChangeTextDocumentParams(changes);
        }
    }

    public handleOpen(
        e: protocol.DidOpenTextDocumentParams,
        forceAppend?: boolean
    ): protocol.DidChangeTextDocumentParams | undefined {
        const cellUri = vscodeUri.URI.parse(e.textDocument.uri);

        // Make sure we don't already have this cell open
        if (this._spans.find((c) => c.uri?.toString() == e.textDocument.uri)) {
            // Can't open twice
            return undefined;
        }

        this._version = Math.max(e.textDocument.version, this._version + 1);
        this._closed = false;

        // Setup uri and such if first open
        this.initialize(cellUri);

        // Make sure to put a newline between this code and the next code
        const newCode = `${e.textDocument.text.replace(/\r/g, '')}\n`;

        // Compute 'fragment' portion of URI. It's the tentative cell index
        const fragment =
            cellUri.scheme === InteractiveInputScheme ? -1 : parseInt(cellUri.fragment.substring(2) || '0');

        // That fragment determines order in the list (if we're not forcing append)
        const insertIndex = forceAppend ? this._spans.length : this.computeInsertionIndex(fragment);

        // Compute where we start from.
        const fromOffset =
            insertIndex < this._spans.length && insertIndex >= 0
                ? this._spans[insertIndex].startOffset
                : this.getEndOffset();
        const fromRealOffset =
            insertIndex < this._spans.length && insertIndex >= 0
                ? this._spans[insertIndex].realOffset
                : this.getRealEndOffset();
        const fromPosition =
            insertIndex < this._spans.length && insertIndex >= 0
                ? this._lines.find((l) => l.offset == fromOffset)!.range.start
                : createPosition(this._lines.length, 0);

        // Create spans for the new code
        const newSpans = this.createSpans(cellUri, newCode, fromOffset, fromRealOffset);
        const newSpansLength = newSpans[newSpans.length - 1].endOffset - fromOffset;
        const newSpansRealLength = newSpans[newSpans.length - 1].realEndOffset - fromRealOffset;

        // Move all the other spans down
        for (let i = insertIndex; i <= this._spans.length - 1; i += 1) {
            this._spans[i].startOffset += newSpansLength;
            this._spans[i].endOffset += newSpansLength;
            this._spans[i].realOffset += newSpansRealLength;
            this._spans[i].realEndOffset += newSpansRealLength;
        }

        // Insert the spans into the list
        this._spans.splice(insertIndex, 0, ...newSpans);

        // Update our lines
        this.computeLines();

        const changes: protocol.TextDocumentContentChangeEvent[] = [
            {
                range: this.createSerializableRange(fromPosition, fromPosition),
                rangeOffset: fromOffset,
                rangeLength: 0, // Opens are always zero
                text: newSpans.map((s) => s.text).join('')
            } as any
        ];
        return this.toDidChangeTextDocumentParams(changes);
    }

    public handleClose(e: protocol.DidCloseTextDocumentParams): protocol.DidChangeTextDocumentParams | undefined {
        const index = this._spans.findIndex((c) => c.uri.toString() === e.textDocument.uri);
        const lastIndex = findLastIndex(this._spans, (c) => c.uri.toString() === e.textDocument.uri);

        // Setup uri and such if a reopen.
        this.initialize(vscodeUri.URI.parse(e.textDocument.uri));

        // Ignore unless in notebook mode. For interactive, cells are still there.
        if (index >= 0 && lastIndex >= 0 && !this._interactiveWindow) {
            this._version += 1;

            // Figure out from to to
            const startOffset = this._spans[index].startOffset;
            const endOffset = this._spans[lastIndex].endOffset;
            const fromPosition = this._lines.find((l) => l.offset == startOffset)!.range.start;
            const toPosition = this._lines.find((l) => l.endOffset == endOffset)!.range.end;

            // Figure out removal diff
            const offsetDiff = endOffset - startOffset;

            // Remove all spans related to this uri
            this._spans = this._spans.filter((c) => c.uri.toString() !== e.textDocument.uri);

            // For every span after, update their offsets
            for (let i = index; i < this._spans.length; i++) {
                this._spans[i].startOffset -= offsetDiff;
                this._spans[i].endOffset -= offsetDiff;
            }

            // Recreate the lines
            this.computeLines();

            const changes: protocol.TextDocumentContentChangeEvent[] = [
                {
                    range: this.createSerializableRange(fromPosition, toPosition),
                    rangeOffset: startOffset,
                    rangeLength: offsetDiff,
                    text: ''
                } as any
            ];

            // If we closed the last cell, mark as closed
            if (this._spans.length == 0) {
                this._closed = true;
            }
            return this.toDidChangeTextDocumentParams(changes);
        } else if (e.textDocument.uri.includes(InteractiveInputScheme)) {
            // Interactive window is actually closing.
            this._closed = true;
            this._spans = [];
            this._lines = [];
            this._realLines = [];
        }
    }

    public handleRefresh(e: RefreshNotebookEvent): protocol.DidChangeTextDocumentParams | undefined {
        // Delete all cells and start over. This should only happen for non interactive (you can't move interactive cells at the moment)
        if (!this._interactiveWindow) {
            // Track our old full range
            const from = createPosition(0, 0);
            const to = this._lines.length > 0 ? this._lines[this._lines.length - 1].rangeIncludingLineBreak.end : from;
            const oldLength = this.getEndOffset();
            const oldRealContents = this.getRealText();
            const normalizedCellText = e.cells.map((c) => c.textDocument.text.replace(/\r/g, ''));
            const newRealContents = `${normalizedCellText.join('\n')}\n`;
            if (newRealContents != oldRealContents) {
                this._version++;
                this._closed = false;
                this._spans = [];
                this._lines = [];
                this._realLines = [];
                this._concatUri = undefined;

                // Just act like we opened all cells again
                e.cells.forEach((c) => {
                    this.handleOpen({ textDocument: c.textDocument }, true);
                });

                // Create one big change
                const changes: protocol.TextDocumentContentChangeEvent[] = [
                    {
                        range: this.createSerializableRange(from, to),
                        rangeOffset: 0,
                        rangeLength: oldLength,
                        text: this.getContents()
                    } as any
                ];

                return this.toDidChangeTextDocumentParams(changes);
            }
        }
        return undefined;
    }

    public dispose() {
        // Do nothing for now.
    }

    public contains(cellUri: vscodeUri.URI | string) {
        return this._spans.find((c) => c.uri.toString() === cellUri.toString()) !== undefined;
    }

    public save(): Promise<boolean> {
        return Promise.resolve(false);
    }

    public lineAt(position: protocol.Position | number): ITextLine {
        // Position should be in the concat coordinates
        if (typeof position === 'number') {
            return this._lines[position as number];
        } else {
            return this._lines[position.line];
        }
    }

    public offsetAt(_position: protocol.Position | protocol.Location): number {
        throw new Error('offsetAt should not be used on concat document. Use a more specific offset computation');
    }

    public positionAt(_offsetOrPosition: number | protocol.Position | protocol.Location): protocol.Position {
        throw new Error('positionAt should not be used on concat document. Use a more specific position computation');
    }
    public getText(range?: protocol.Range | undefined): string {
        // Range should be from the concat document
        const contents = this.getContents();
        if (!range) {
            return contents;
        } else {
            const startOffset = this._lines[range.start.line].offset + range.start.character;
            const endOffset = this._lines[range.end.line].offset + range.end.character;
            return contents.substring(startOffset, endOffset - startOffset);
        }
    }

    public concatPositionAt(location: protocol.Location): protocol.Position {
        // Find first real line of the cell (start line needs to be added to this)
        const firstRealLine = this._realLines.find((r) => r.cellUri.toString() === location.uri.toString());

        if (firstRealLine) {
            // Line number is inside a real line
            const realLine = this._realLines[location.range.start.line + firstRealLine.lineNumber];

            // Convert real line offset to outgoing offset
            const outgoingOffset = this.mapRealToConcatOffset(realLine.offset + location.range.start.character);

            // Find the concat line that has this offset
            const concatLine = this._lines.find((l) => outgoingOffset >= l.offset && outgoingOffset < l.endOffset);
            if (concatLine) {
                return createPosition(concatLine.lineNumber, outgoingOffset - concatLine.offset);
            }
        }
        return createPosition(0, 0);
    }

    public concatOffsetAt(location: protocol.Location): number {
        // Location is inside of a cell
        const firstRealLine = this._realLines.find((r) => r.cellUri.toString() === location.uri.toString());
        if (firstRealLine) {
            // Line number is inside a real line
            const realLine = this._realLines[location.range.start.line + firstRealLine.lineNumber];

            // Use its offset (real offset) to find our outgoing offset
            return this.mapRealToConcatOffset(realLine.offset + location.range.start.character);
        }
        return 0;
    }

    public concatRangeOf(cellUri: vscodeUri.URI) {
        const cellLines = this._lines.filter((l) => l.cellUri.toString() === cellUri.toString());
        const firstLine = cellLines[0];
        const lastLine = cellLines[cellLines.length - 1];
        if (firstLine && lastLine) {
            return createRange(firstLine.range.start, lastLine.rangeIncludingLineBreak.end);
        }
        return createRange(createPosition(0, 0), createPosition(0, 0));
    }
    public realRangeOf(cellUri: vscodeUri.URI) {
        // Get all the real spans
        const realSpans = this._spans.filter((s) => s.uri.toString() == cellUri.toString() && s.inRealCell);
        const startOffset = realSpans[0].startOffset || 0;
        const endOffset = realSpans.length > 0 ? realSpans[realSpans.length - 1].endOffset : startOffset;

        // Find the matching concat lines
        const firstLine = this._lines.find((l) => startOffset >= l.offset && startOffset < l.endOffset);
        const lastLine = this._lines.find((l) => endOffset >= l.offset && endOffset <= l.endOffset);
        if (firstLine && lastLine) {
            return createRange(firstLine.range.start, lastLine.rangeIncludingLineBreak.end);
        }
        return createRange(createPosition(0, 0), createPosition(0, 0));
    }
    public getCells(): vscodeUri.URI[] {
        return [...new Set(this._spans.map((c) => c.uri))];
    }

    public notebookLocationAt(positionOrRange: protocol.Range | protocol.Position): protocol.Location {
        // positionOrRange should be in concat ranges
        const range = 'line' in positionOrRange ? createRange(positionOrRange, positionOrRange) : positionOrRange;

        // Get the start and end line
        let startLine: NotebookConcatLine | undefined = this._lines[range.start.line];
        let endLine = this._lines[range.end.line];

        if (startLine && endLine) {
            // Compute offset range of lines
            let startOffset = startLine.offset + range.start.character;
            let endOffset = endLine.offset + range.end.character;

            // Find the spans that intersect this range that also have real code
            const spans = this._spans.filter(
                (s) =>
                    s.inRealCell &&
                    ((startOffset >= s.startOffset && startOffset < s.endOffset) ||
                        (endOffset >= s.startOffset && endOffset <= s.endOffset))
            );

            // Remap the start offset if necessary
            startOffset = spans.length > 0 ? Math.max(startOffset, spans[0].startOffset) : -1;

            // Remap the start line back to the new start offset
            startLine = this._lines.find((l) => startOffset >= l.offset && startOffset < l.endOffset);
            if (startLine) {
                return {
                    uri: startLine.cellUri.toString(),
                    range: createRange(
                        this.notebookPositionAt(createPosition(startLine.lineNumber, startOffset - startLine.offset)),
                        this.notebookPositionAt(range.end)
                    )
                };
            }
        }

        // Not in the real code, return an undefined URI
        return {
            uri: '',
            range
        };
    }

    private notebookPositionAt(outgoingPosition: protocol.Position) {
        // Map the concat line to the real line
        const lineOffset = this._lines[outgoingPosition.line].offset;
        const realOffset = this.mapConcatToClosestRealOffset(lineOffset);
        const realLine = this._realLines.find((r) => realOffset >= r.offset && realOffset < r.endOffset);

        // Find the first line of the same uri
        const firstRealLine = this._realLines.find((r) => r.cellUri.toString() === realLine?.cellUri.toString());

        // firstRealLine is the first real line of the cell. It has the relative line number
        const startLine = firstRealLine && realLine ? realLine.lineNumber - firstRealLine.lineNumber : 0;

        // Character offset has to be mapped too
        const charOffset = this.mapConcatToClosestRealOffset(lineOffset + outgoingPosition.character);
        const startChar = charOffset - (realLine?.offset || 0);

        return createPosition(startLine, startChar);
    }

    public notebookOffsetAt(cellUri: vscodeUri.URI, concatOffset: number) {
        // Convert the offset to the real offset
        const realOffset = this.mapConcatToClosestRealOffset(concatOffset);

        // Find the span with this cell URI
        const span = this._spans.find((s) => s.uri.toString() === cellUri.toString());

        // The relative cell offset is from the beginning of the first span in the cell
        return span ? realOffset - span.realOffset : realOffset;
    }

    public getWordRangeAtPosition(
        position: protocol.Position,
        regexp?: RegExp | undefined
    ): protocol.Range | undefined {
        if (!regexp) {
            // use default when custom-regexp isn't provided
            regexp = DefaultWordPattern;
        } else if (regExpLeadsToEndlessLoop(regexp)) {
            // use default when custom-regexp is bad
            console.warn(
                `[getWordRangeAtPosition]: ignoring custom regexp '${regexp.source}' because it matches the empty string.`
            );
            regexp = DefaultWordPattern;
        }

        const wordAtText = getWordAtText(
            position.character + 1,
            ensureValidWordDefinition(regexp),
            this._lines[position.line].text,
            0
        );

        if (wordAtText) {
            return createRange(
                createPosition(position.line, wordAtText.startColumn - 1),
                createPosition(position.line, wordAtText.endColumn - 1)
            );
        }
        return undefined;
    }
    public validateRange(range: protocol.Range): protocol.Range {
        return range;
    }
    public validatePosition(position: protocol.Position): protocol.Position {
        return position;
    }

    public get textDocumentItem(): protocol.TextDocumentItem {
        return {
            uri: this.concatUri.toString(),
            languageId: this.languageId,
            version: this.version,
            text: this.getText()
        };
    }

    public get textDocumentId(): protocol.VersionedTextDocumentIdentifier {
        return {
            uri: this.concatUri.toString(),
            version: this.version
        };
    }

    private getContents(): string {
        return this._spans.map((s) => s.text).join('');
    }

    private toDidChangeTextDocumentParams(
        changes: protocol.TextDocumentContentChangeEvent[]
    ): protocol.DidChangeTextDocumentParams {
        return {
            textDocument: {
                version: this.version,
                uri: this.concatUri.toString()
            },
            contentChanges: changes
        };
    }

    private mapRealToConcatOffset(realOffset: number): number {
        // Find the real span that has this offset
        const realSpan = this._spans.find(
            (r) => r.inRealCell && realOffset >= r.realOffset && realOffset < r.realEndOffset
        );
        if (realSpan) {
            // If we found a match, add the diff. Note if we have a real span
            // that means any 'real' offset it in it is not part of a split
            return realOffset - realSpan.realOffset + realSpan.startOffset;
        }
        return realOffset;
    }

    private mapConcatToClosestRealOffset(concatOffset: number): number {
        // Find the concat span that has this offset
        const concatSpan = this._spans.find((r) => concatOffset >= r.startOffset && concatOffset < r.endOffset);
        if (concatSpan) {
            // Diff is into the concat span
            const diff = concatOffset - concatSpan.startOffset;

            // If real cell, then just add real offset
            if (concatSpan.inRealCell) {
                return diff + concatSpan.realOffset;
            }

            // If not a real cell, just use the plain real offset.
            return concatSpan.realOffset;
        }
        return concatOffset;
    }

    private createSpan(
        cellUri: vscodeUri.URI,
        text: string,
        realText: string,
        offset: number,
        realOffset: number
    ): NotebookSpan {
        // Compute fragment based on cell uri
        const fragment =
            cellUri.scheme === InteractiveInputScheme ? -1 : parseInt(cellUri.fragment.substring(2) || '0');
        return {
            fragment,
            uri: cellUri,
            inRealCell: true,
            startOffset: offset,
            endOffset: offset + text.length,
            realOffset,
            realEndOffset: realOffset + realText.length,
            text,
            realText
        };
    }

    private createTypeIgnoreSpan(cellUri: vscodeUri.URI, offset: number, realOffset: number): NotebookSpan {
        // Compute fragment based on cell uri
        const fragment =
            cellUri.scheme === InteractiveInputScheme ? -1 : parseInt(cellUri.fragment.substring(2) || '0');
        return {
            fragment,
            uri: cellUri,
            inRealCell: false,
            startOffset: offset,
            endOffset: offset + TypeIgnoreAddition.length,
            realOffset,
            realEndOffset: realOffset,
            text: TypeIgnoreAddition,
            realText: ''
        };
    }

    private createHeaderSpans(cellUri: vscodeUri.URI): NotebookSpan[] {
        let extraHeader = this.getNotebookHeader(cellUri);

        if (extraHeader.length) {
            // Make sure it ends with a line feed
            if (!extraHeader.endsWith('\n')) {
                extraHeader = `${extraHeader}\n`;
            }
            return [
                {
                    fragment: -1,
                    uri: cellUri,
                    inRealCell: false,
                    startOffset: 0,
                    endOffset: HeaderAddition.length + extraHeader.length,
                    realOffset: 0,
                    realEndOffset: 0,
                    text: `${HeaderAddition}${extraHeader}`,
                    realText: ''
                }
            ];
        }

        return [
            {
                fragment: -1,
                uri: cellUri,
                inRealCell: false,
                startOffset: 0,
                endOffset: HeaderAddition.length,
                realOffset: 0,
                realEndOffset: 0,
                text: HeaderAddition,
                realText: ''
            }
        ];
    }

    // Public for unit testing
    public createSpans(cellUri: vscodeUri.URI, text: string, offset: number, realOffset: number): NotebookSpan[] {
        // Go through each line, gathering up spans
        const lines = splitLines(text);
        let spans: NotebookSpan[] = [];

        // If this the absolute first cell, add the header spans in (skip if input box)
        if (offset == 0 && !cellUri.scheme.includes(InteractiveInputScheme)) {
            spans = this.createHeaderSpans(cellUri);
            offset = spans[spans.length - 1].endOffset;

            // Real offset doesn't update because header spans aren't part of
            // the real cells
        }

        let startRealOffset = realOffset;
        let spanOffset = 0;
        let lineOffset = 0;
        lines.forEach((l) => {
            if (!this._disableTypeIgnore && TypeIgnoreTransforms.find((transform) => transform.regex.test(l))) {
                // This means up to the current text needs to be turned into a span
                spans.push(
                    this.createSpan(
                        cellUri,
                        text.substring(spanOffset, lineOffset + l.length), // Dont include \n in first span
                        text.substring(spanOffset, lineOffset + l.length),
                        offset,
                        spanOffset + startRealOffset
                    )
                );

                // Update offset to next spot
                offset = spans[spans.length - 1].endOffset;
                lineOffset += l.length;

                // Beginning of next span is the end of this line (minus the \n)
                spanOffset = lineOffset;

                // Then push after that a TypeIgnoreSpan
                spans.push(this.createTypeIgnoreSpan(cellUri, offset, spanOffset + startRealOffset));

                // Update offset using last span (length of type ignore)
                offset = spans[spans.length - 1].endOffset;

                // Add on the /n for the line offset
                lineOffset += 1;
            } else {
                // Move up another line
                lineOffset += l.length + 1;
            }
        });

        // See if anymore real text left
        if (spanOffset < text.length) {
            spans.push(
                this.createSpan(
                    cellUri,
                    text.substring(spanOffset),
                    text.substring(spanOffset),
                    offset,
                    startRealOffset + spanOffset
                )
            );
        }

        return spans;
    }

    private getRealText(cellUri?: vscodeUri.URI): string {
        if (cellUri) {
            return this._spans
                .filter((s) => s.inRealCell && s.uri.toString() === cellUri.toString())
                .map((s) => s.realText)
                .join('');
        }
        return this._spans
            .filter((s) => s.inRealCell)
            .map((s) => s.realText)
            .join('');
    }

    private createTextLines(uri: vscodeUri.URI, cell: string, prev: NotebookConcatLine | undefined) {
        const split = splitLines(cell);
        return split.map((s) => {
            const nextLine = this.createTextLine(uri, s, prev);
            prev = nextLine;
            return nextLine;
        });
    }

    private computeLinesUsingFunc(uris: vscodeUri.URI[], func: (span: NotebookSpan) => string): NotebookConcatLine[] {
        const results: NotebookConcatLine[] = [];
        let prevLine: NotebookConcatLine | undefined;
        uris.forEach((uri) => {
            const cell = this._spans
                .filter((s) => s.uri.toString() == uri.toString())
                .map(func)
                .join('');
            results.push(...this.createTextLines(uri, cell, prevLine));
            prevLine = results[results.length - 1];
        });
        return results;
    }

    private computeLines() {
        // Turn the spans into their cell counterparts
        const uris = this.getCells();
        this._lines = this.computeLinesUsingFunc(uris, (s) => s.text);
        this._realLines = this.computeLinesUsingFunc(uris, (s) => s.realText);
    }

    private createTextLine(
        cellUri: vscodeUri.URI,
        contents: string,
        prevLine: NotebookConcatLine | undefined
    ): NotebookConcatLine {
        return new NotebookConcatLine(
            cellUri,
            contents,
            prevLine ? prevLine.lineNumber + 1 : 0,
            prevLine ? prevLine.offset + prevLine.rangeIncludingLineBreak.end.character : 0
        );
    }

    private getEndOffset(): number {
        return this._spans.length > 0 ? this._spans[this._spans.length - 1].endOffset : 0;
    }

    private getRealEndOffset(): number {
        return this._spans.length > 0 ? this._spans[this._spans.length - 1].realEndOffset : 0;
    }

    private createSerializableRange(start: protocol.Position, end: protocol.Position): protocol.Range {
        // This funciton is necessary so that the Range can be passed back
        // over a remote connection without including all of the extra fields that
        // VS code puts into a Range object.
        const result = {
            start: {
                line: start.line,
                character: start.character
            },
            end: {
                line: end.line,
                character: end.character
            }
        };
        return result as protocol.Range;
    }

    private computeInsertionIndex(fragment: number): number {
        // Remember if last cell is already the input box
        const inputBoxPresent = this._spans[this._spans.length - 1]?.uri?.scheme === InteractiveInputScheme;
        const totalLength = inputBoxPresent ? this._spans.length - 1 : this._spans.length;

        // Find index based on fragment
        const index = fragment == -1 ? this._spans.length : this._spans.findIndex((c) => c.fragment > fragment);
        return index < 0 ? totalLength : index;
    }

    private initialize(cellUri: vscodeUri.URI) {
        if (!this._concatUri?.fsPath) {
            this._interactiveWindow = isInteractiveCell(cellUri);
            const dir = getConcatDocumentRoot(cellUri);

            // Path has to match no matter how many times we open it.
            const concatFilePath = path.join(
                dir,
                `${NotebookConcatPrefix}${shajs.sha1(cellUri.fsPath).substring(0, 12)}.py`
            );
            this._concatUri = vscodeUri.URI.file(concatFilePath);
            this._notebookUri = this._interactiveWindow
                ? cellUri.with({ scheme: InteractiveScheme, path: cellUri.fsPath, fragment: '' })
                : cellUri.fragment.includes('untitled')
                ? cellUri.with({ scheme: 'untitled', path: cellUri.fsPath, fragment: '', query: '' }) // Special case for untitled files. File path is too long
                : vscodeUri.URI.file(cellUri.fsPath);
        }
    }
}
