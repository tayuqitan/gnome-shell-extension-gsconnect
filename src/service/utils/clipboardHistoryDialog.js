// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import ClipboardCacheControls from './clipboardCacheControls.js';

/** History UI deliberately does not preview copied text or images. */
export default class ClipboardHistoryDialog {
    constructor(history, {peerName = '', onActivate, onLimits, onClear, disk, persistence} = {}) {
        this.history = history;
        this.onActivate = onActivate;
        this.persistence = persistence;
        this.window = new Gtk.Dialog({
            title: `剪贴板历史 · ${peerName}`,
            application: Gio.Application.get_default(),
            default_width: 540,
            default_height: 480,
        });
        this.window.add_button('关闭', Gtk.ResponseType.CLOSE);
        this.window.connect('response', () => this.window.destroy());
        const content = this.window.get_content_area();
        content.spacing = 10;
        content.border_width = 12;
        content.add(new Gtk.Label({
            label: '默认仅本次会话保存。选择后恢复剪贴板，再在目标应用按 Ctrl+V。',
            wrap: true, xalign: 0,
        }));
        content.add(new Gtk.Label({
            label: '文件历史不预传文件内容。源文件已改变、被删除或历史已清理时可能无法再次粘贴。',
            wrap: true, xalign: 0,
        }));
        if (persistence) {
            const save = new Gtk.CheckButton({label: '将字节历史保存到本机磁盘（明文，默认关闭）'});
            save.active = persistence.getEnabled();
            const state = this.persistenceStatus = new Gtk.Label({xalign: 0, wrap: true,
                label: persistence.getStatus()});
            save.connect('toggled', () => {
                try {
                    persistence.setEnabled(save.active);
                    state.label = persistence.getStatus();
                } catch {
                    state.label = '更改磁盘历史设置失败';
                }
            });
            content.add(save);
            content.add(new Gtk.Label({xalign: 0, wrap: true,
                label: '可能保存未标记的密码等敏感正文。仅保存已缓存文字/图片等字节快照，总正文最多 8 MiB；' +
                    '文件记录和旧网络租约不保存。关闭时尝试清除磁盘快照，不等于安全擦除。'}));
            content.add(state);
        }
        const controls = new Gtk.Box({spacing: 8});
        controls.add(new Gtk.Label({label: '条数'}));
        this.count = Gtk.SpinButton.new_with_range(0, 1000, 1);
        this.count.set_value(history.maxItems);
        controls.add(this.count);
        controls.add(new Gtk.Label({label: '历史容量 MiB'}));
        this.capacity = Gtk.SpinButton.new_with_range(0, 1024, 1);
        this.capacity.set_value(history.maxBytes / 1048576);
        controls.add(this.capacity);
        const apply = new Gtk.Button({label: '应用限制'});
        apply.connect('clicked', () => {
            const limits = {maxItems: this.count.get_value_as_int(),
                maxBytes: this.capacity.get_value_as_int() * 1048576};
            if (onLimits)
                onLimits(limits);
            else
                history.setLimits(limits);
        });
        controls.add(apply);
        content.add(controls);
        if (disk)
            content.add(new ClipboardCacheControls(disk).widget);
        const clear = new Gtk.Button({label: '清空历史'});
        clear.connect('clicked', () => {
            if (onClear)
                onClear();
            else
                history.clear();
            this.render();
        });
        content.add(clear);
        this.status = new Gtk.Label({xalign: 0, wrap: true});
        content.add(this.status);
        const scroll = new Gtk.ScrolledWindow({vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER});
        this.rows = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8});
        scroll.add(this.rows);
        content.add(scroll);
        this.unsubscribe = history.subscribe(() => this.render());
        this.window.connect('destroy', () => {
            this.destroyed = true;
            this.unsubscribe();
        });
        this.render();
    }

    render() {
        if (this.persistenceStatus)
            this.persistenceStatus.label = this.persistence.getStatus();
        const serial = this.renderSerial = (this.renderSerial || 0) + 1;
        for (const child of this.rows.get_children())
            child.destroy();
        const entries = this.history.list();
        this.status.label = `${entries.length} 条 · ${(this.history.bytes / 1048576).toFixed(2)} MiB`;
        for (const entry of entries) {
            const row = new Gtk.Box({spacing: 8});
            const origin = entry.direction === 'local'
                ? '本机复制' : `对方传入 · ${entry.peerName}`;
            const type = entry.offer.files.length
                ? `${entry.offer.files.length} 个文件：${entry.offer.files.map(f => f.name).join('、')}`
                : entry.offer.types.join('、');
            const available = entry.uris || entry.values.size ? '有缓存' : '需要源端数据';
            const label = new Gtk.Label({
                label: `${origin} · ${new Date(entry.created).toLocaleString()}\n${type}\n${available}`,
                xalign: 0, wrap: true, hexpand: true,
            });
            row.add(label);
            const select = new Gtk.Button({label: '恢复'});
            select.connect('clicked', async () => {
                select.sensitive = false;
                try {
                    if (!this.history.get(entry.key))
                        throw new Error('此记录已被清理');
                    await this.onActivate(entry);
                    if (!this.destroyed)
                        this.status.label = '已恢复剪贴板，请在目标应用按 Ctrl+V。';
                } catch (error) {
                    if (!this.destroyed)
                        this.status.label = `无法恢复：${error.message}`;
                } finally {
                    if (!this.destroyed && this.renderSerial === serial)
                        select.sensitive = true;
                }
            });
            row.add(select);
            const remove = new Gtk.Button({label: '删除'});
            remove.connect('clicked', () => this.history.remove(entry.key));
            row.add(remove);
            this.rows.add(row);
        }
        this.rows.show_all();
    }

    show() {
        this.window.show_all();
        this.window.present();
    }

    destroy() {
        this.window.destroy();
    }
}
