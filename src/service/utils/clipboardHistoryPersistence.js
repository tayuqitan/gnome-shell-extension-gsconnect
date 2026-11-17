// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/** Opt-in controller. Errors never expose clipboard content. */
export default class ClipboardHistoryPersistence {
    constructor(history, storage, enabled = false) {
        this.history = history;
        this.storage = storage;
        this.enabled = false;
        this.busy = false;
        this.status = '未开启磁盘历史';
        this.unsubscribe = history.subscribe(() => this.save());
        if (enabled)
            this.setEnabled(true);
    }

    setEnabled(enabled) {
        this.enabled = false;
        this.busy = true;
        try {
            if (enabled) {
                const text = this.storage.read();
                if (text !== null)
                    this.history.restorePersistent(text);
                this.enabled = true;
            } else {
                this.storage.clear();
                this.status = '磁盘历史已清除；内存历史保持不变';
            }
        } catch (error) {
            this.status = '磁盘历史不可用：读取、校验或清除失败；未覆盖原文件';
            throw error;
        } finally {
            this.busy = false;
        }
        if (this.enabled)
            this.save();
    }

    save() {
        if (!this.enabled || this.busy)
            return;
        try {
            // A synchronous atomic replacement also makes explicit history
            // removal/clear durable before the UI reports completion.
            if (this.history.entries.size === 0)
                this.storage.clear();
            else
                this.storage.write(this.history.serializePersistent());
            this.status = '已保存可持久化的字节快照；文件记录不保存';
        } catch {
            this.status = '磁盘历史保存失败；内存历史仍可用，磁盘可能保留旧记录';
        }
    }

    close() {
        // Unsubscribe BEFORE RichClipboard.destroy clears session memory.
        this.unsubscribe();
        this.save();
        this.enabled = false;
    }
}
