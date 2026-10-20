import type { AccessPolicyConfig } from './chat.js';
import type { OneBotEvent } from './connection.js';
/** Runtime allowlist file name, under mediaDir. */
export declare const GROUP_ALLOWLIST_FILE = "group-allowlist.json";
/** A snapshot of the allowlist layers, for /group list. */
export interface GroupAccessSnapshot {
    configured: string[];
    added: string[];
    removed: string[];
    effective: string[];
    groupPolicy: AccessPolicyConfig['groupPolicy'];
}
/** The /group command's view of GroupAccess. */
export interface GroupAccessLike {
    snapshot(): GroupAccessSnapshot;
    allow(groupId: string): Promise<'added' | 'already'>;
    remove(groupId: string): Promise<'removed' | 'absent'>;
}
/** True for a plausible QQ group number. */
export declare function isGroupId(value: string): boolean;
export declare class GroupAccess implements GroupAccessLike {
    private readonly policy;
    private readonly configured;
    private readonly file;
    private readonly log;
    private added;
    private removed;
    private readonly writer;
    constructor(options: {
        policy: {
            groupAllowFrom: readonly string[];
            groupPolicy: AccessPolicyConfig['groupPolicy'];
        };
        mediaDir: string;
        log: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void;
    });
    /** Load the persisted runtime layer (missing file = none; corrupt file =
     * warn and keep the configured list only). */
    load(): Promise<void>;
    snapshot(): GroupAccessSnapshot;
    allow(groupId: string): Promise<'added' | 'already'>;
    remove(groupId: string): Promise<'removed' | 'absent'>;
    /** Replace the policy's list in place: configured ∪ added − removed. */
    private apply;
    private save;
}
/** What handleGroupEvent touches. */
export interface GroupEventDeps {
    adminUsers(): readonly string[];
    selfId(): string;
    access: GroupAccessLike;
    /** Raw OneBot action call (set_friend_add_request / set_group_add_request). */
    call(action: string, params: Record<string, unknown>): Promise<unknown>;
    /** Tell every admin something in private chat (best-effort). */
    notifyAdmins(text: string): Promise<void>;
    config: {
        autoAcceptAdminRequests: boolean;
        autoAllowInvitedGroups: boolean;
        ownerTitle?: string;
    };
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
}
/**
 * Handle one OneBot request/notice event. Returns true when it was acted on
 * (approved, allowlisted or reported), false when it is not ours.
 */
export declare function handleGroupEvent(event: OneBotEvent, deps: GroupEventDeps): Promise<boolean>;
/** /group usage line. */
export declare const GROUP_USAGE = "\u7528\u6CD5\uFF1A/group [list] \u67E5\u770B\u767D\u540D\u5355\uFF1B/group allow <\u7FA4\u53F7> \u5141\u8BB8\u5728\u8FD9\u4E2A\u7FA4\u8BF4\u8BDD\uFF1B/group remove <\u7FA4\u53F7> \u79FB\u51FA\u767D\u540D\u5355\uFF08\u4E5F\u53EF\u4EE5\u5199 \u5141\u8BB8 / \u79FB\u9664 / \u5217\u8868\uFF09";
/** /group command body. */
export declare function handleGroupCommand(access: GroupAccessLike | undefined, arg: string, reply: (text: string) => Promise<unknown>): Promise<void>;
