// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import Gtk from 'gi://Gtk';

/** Global quota controls, deliberately offering no exposed-file deletion. */
export default class ClipboardCacheControls {
    constructor(disk) {
        this.disk = disk;
        this.destroyed = false;
        this.widget = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
        this.widget.connect('destroy', () => {
            this.destroyed = true;
        });
        const row = new Gtk.Box({spacing: 8});
        row.add(new Gtk.Label({label: '本机共享下载额度 GiB'}));
        this.capacity = Gtk.SpinButton.new_with_range(0, 1024, 1);
        this.capacity.set_value(disk.getLimit() / 1073741824);
        row.add(this.capacity);
        const apply = new Gtk.Button({label: '保存下载额度'});
        apply.connect('clicked', () => {
            try {
                disk.setLimit(this.capacity.get_value_as_int() * 1073741824);
                this.status.label = '已保存。降低额度不删除文件，超额时停止新下载。';
            } catch (error) {
                this.status.label = `保存失败：${error.message}`;
            }
        });
        row.add(apply);
        this.widget.add(row);
        this.widget.add(new Gtk.Label({xalign: 0, wrap: true,
            label: '0 禁止新下载。只统计 v2 缓存，旧版缓存不计入。已提供给应用的文件不会自动删除；清空历史也不会删除这些文件。'}));
        this.widget.add(new Gtk.Label({xalign: 0, wrap: true,
            label: '这是本机所有设备共享的下载准入额度，不是硬磁盘上限。其他程序写入或追加缓存文件仍可使实际占用超额。'}));
        const actions = new Gtk.Box({spacing: 8});
        const inspect = new Gtk.Button({label: '检查磁盘用量'});
        inspect.connect('clicked', () => {
            try {
                const state = disk.inspect();
                this.status.label = `记账用量 ${(state.used / 1073741824).toFixed(3)} GiB / ` +
                    `${(state.limit / 1073741824).toFixed(3)} GiB；` +
                    `本会话待重试清理 ${state.failedBatches} 批。`;
            } catch (error) {
                this.status.label = `检查失败：${error.message}`;
            }
        });
        actions.add(inspect);
        const cleanup = new Gtk.Button({label: '重试清理失败下载'});
        cleanup.connect('clicked', async () => {
            cleanup.sensitive = false;
            try {
                const result = await disk.cleanup();
                if (!this.destroyed)
                    this.status.label = `已清理 ${result.removed} 批，仍失败 ${result.failed} 批。`;
            } catch (error) {
                if (!this.destroyed)
                    this.status.label = `清理失败：${error.message}`;
            } finally {
                if (!this.destroyed)
                    cleanup.sensitive = true;
            }
        });
        actions.add(cleanup);
        this.widget.add(actions);
        this.widget.add(new Gtk.Label({xalign: 0, wrap: true,
            label: '仅重试本会话已停止写入、从未交给应用且先前清理失败的下载。不会清理成功下载、重启前遗留文件或用户源文件。'}));
        this.status = new Gtk.Label({xalign: 0, wrap: true});
        this.widget.add(this.status);
    }
}
