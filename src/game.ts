import {GuildMember, GuildChannel, ReactionCollector, GuildTextBasedChannel, MessageCollector, TextChannel} from "discord.js"
import Discord from "discord.js"
import {Role, Side} from "./role";
import {death_messages, list_lynch, shuffle_array, State} from "./util";
import { Inventory, Item, items } from "./item";
import { kaismile } from "./bot";

export const TALK_REACT_PERMS = {VIEW_CHANNEL: true, SEND_MESSAGES: true, ADD_REACTIONS: true};
export const VIEW_ONLY_PERMS = {VIEW_CHANNEL: true, SEND_MESSAGES: false, ADD_REACTIONS: false};
export const NO_SEND_PERMS = {SEND_MESSAGES: false, ADD_REACTIONS: false, ATTACH_FILES: false};
export const PARTIAL_SEND_PERMS = {SEND_MESSAGES: true, ADD_REACTIONS: true, ATTACH_FILES: false};
export const FULL_SEND_PERMS = {SEND_MESSAGES: true, ADD_REACTIONS: true, ATTACH_FILES: true};

export class Player {
	number: number;
	name: string;
	role: Role;
	game: Game;
	member: GuildMember;
	inventory: Inventory = new Inventory();

	/// collector for ;use DMs
	item_collector?: MessageCollector;
	already_sent_player_list?: boolean;

	// these are used at day and reset every day
	dead?: boolean;
	lynch_vote?: number;

	// these are used at night and reset every night
	/// should not die tonight. set by Doc
	protected: boolean = false;
	/// should not get a report tonight. set by Hooker
	hooked: boolean = false;

	// these are internal
	/// if waiting for the player to select an action
	action_pending: boolean = false;
	/// if waiting to be able to send a report
	action_report_pending: boolean = false;
	/// temporary data used by the roles
	data: any;

	do_state(state: State, game: Game) {
		game.mafia_secret_chat.send("[debug] player " + this.number + " do state " + State[state]);
		let act = this.role.actions[state];
		if(act) {
			act(this, game);
		} else if(state == State.GAME) {
			if(this.role.side == Side.MAFIA) {
				game.mafia_secret_chat.send(`<@${this.member.id}> You are number ${this.number}, ${this.role.name}. ${this.role.help}`);
			} else {
				this.member.send(`You are number ${this.number}, ${this.role.name}. ${this.role.help}`);
			}
		}
	}

	can_overturn(): boolean {
		return this.role.can_overturn || !!this.inventory.items.find(x => x.can_overturn);
	}

	receive(item: Item) {
		this.inventory.add_item(item);
		this.member.send(`You have received a ${item.name}.`);
	}

	remove(item: Item) {
		this.inventory.items.splice(this.inventory.items.indexOf(item), 1);
		if(this.inventory.items.length !== 0) {
			this.member.send(`You have lost a ${item.name}.\n${this.inventory.print(this, this.game)}`);
		} else {
			this.member.send(`You have lost a ${item.name}. Your inventory is empty.`);
		}
	}
}

//export let maf_start_state: State = {};

export const valid_options = ["daystart", "dayless", "nightless"];

export const foods = [
	"spaghetti",
	"rice",
	"burger",
	"macaroni",
	"chicken meat",
	"steak",
	"fish",
	"instant noodles",
	"chicken nuggets",
	"strawberry",
	"lemon pie",
	"chocolate",
	"mashed potatoes",
	"fries"
];

export class Game {
	all_players: Player[];
	/// only living, playing players
	players: {[number: number]: Player};
	options: string[];
	day_channel: TextChannel;
	mafia_secret_chat: TextChannel;
	/// hooker has already hooked or there is no hooker, used by action collectors in State.NIGHT
	night_report_passed: boolean;
	/// same as above but for mafia. just in case there is a role that affects mafia actions in the future
	mafia_night_report_passed: boolean;
	cur_state: State = State.GAME;
	timeout?: NodeJS.Timeout = null;
	day_collector?: MessageCollector = null;
	mafia_collector?: MessageCollector = null;
	lunches: string[] = [];
	day: number = 1;
	hiding_numbers: boolean = true;
	kill_pending: boolean;
	killing: number = 0;

	role_mafia_player: Discord.Role;

	post_win(side: Side, side2?: Side) {
		let list = "";
		for(let player of Object.values(this.players)) {
			if(player.role.side == side || player.role.side == side2) {
				list += ` <@${player.member.id}>`;
			}
		}
		for(let player of this.all_players) {
			list += `\n${player.number}- ${player.name} (${player.role.name})`;
			if(player.dead) list += " (dead)";
		}
		this.do_state(State.GAME_END);
		this.day_channel.send(`<@&${this.role_mafia_player.id}> The ${Side[side]} won!${list}`);
	}

	update_night() {
		if(this.kill_pending) {
			this.mafia_secret_chat.send("[debug] not end night because kill pending");
			return;
		}
		if(this.cur_state != State.NIGHT || this.kill_pending) {
			this.mafia_secret_chat.send("[debug] not end night because its not night (its actually " + State[this.cur_state] + ")");
			return;
		}
		for(let player of Object.values(this.players)) {
			if(player.action_pending) {
				this.mafia_secret_chat.send("[debug] not end night because action pending from " + player.name);
				return;
			}
		}
		for(let player of Object.values(this.players)) {
			if(player.role.side === Side.MAFIA && player.action_report_pending) {
				if(this.mafia_night_report_passed) {
					player.do_state(State.NIGHT_REPORT, this);
				} else if(this.killing !== player.number) {
					this.mafia_secret_chat.send("[debug] not end night because hooker not done and action report pending to " + player.name);
					return false;
				}
			}
		}
		for(let player of Object.values(this.players)) {
			if(player.role.side === Side.VILLAGE && player.action_report_pending) {
				if(this.night_report_passed) {
					player.do_state(State.NIGHT_REPORT, this);
				} else if(this.killing !== player.number) {
					this.mafia_secret_chat.send("[debug] not end night because hooker not done and action report pending to " + player.name);
					return false;
				}
			}
		}
		if(this.cur_state != State.NIGHT) {
			this.mafia_secret_chat.send("[debug] not end night because its not night (its actually " + State[this.cur_state] + ")");
			return;
		}
		this.do_state(State.NIGHT_END);
	}

	update_win_condition() {
		let sides = [0, 0, 0];
		let village_can_overturn = false;
		for(let player of Object.values(this.players)) {
			if(player.role.side == Side.VILLAGE && player.can_overturn()) village_can_overturn = true;
			sides[player.role.side.valueOf()]++;
		}
		if(village_can_overturn? sides[Side.VILLAGE.valueOf()] == 0: (sides[Side.VILLAGE.valueOf()] <= sides[Side.MAFIA.valueOf()])) {
			this.post_win(Side.MAFIA);
		} else if(sides[Side.MAFIA.valueOf()] == 0) {
			this.post_win(Side.VILLAGE);
		}
	}

	kill(player: Player) {
		player.dead = true;
		if(player.item_collector) {
			player.item_collector.stop("dead");
		}
		player.member.roles.remove(this.role_mafia_player);
		this.mafia_secret_chat.permissionOverwrites.delete(player.member);
		player.do_state(State.DEAD, this);
		delete this.players[player.number];
		this.update_win_condition();
	}

	async do_state(state: State): Promise<void> {
		this.mafia_secret_chat.send("[debug] game do state " + State[state]);
		this.cur_state = state;
		switch(state) {
			case State.GAME:
				this.day_channel.permissionOverwrites.edit(this.day_channel.guild.roles.everyone, NO_SEND_PERMS);
				this.day_channel.permissionOverwrites.edit(this.role_mafia_player, NO_SEND_PERMS);
				this.mafia_secret_chat.permissionOverwrites.edit(this.role_mafia_player, NO_SEND_PERMS);
				for(let player of Object.values(this.players)) {
					if(player.role.side === Side.MAFIA) {
						await this.mafia_secret_chat.permissionOverwrites.create(player.member, {VIEW_CHANNEL: true});
					} else {
						this.mafia_secret_chat.permissionOverwrites.delete(player.member);
					}
					player.member.createDM().then(ch => {
						player.item_collector = ch.createMessageCollector();
						player.item_collector.on("collect", msg => {
							let m = msg.content.match(/^; *use +([a-zA-Z0-9]+)( +([0-9]+))?$/);
							if(m) {
								let it = player.inventory.items.find(it => it.name.toLowerCase() == m[1].toLowerCase());
								if(!it) {
									player.member.send("You don't have this item.");
									return;
								}
								if(it.night_use? this.cur_state === State.NIGHT: this.cur_state === State.DAY) {
									if(it.no_target) {
										it.use(player, player, player.game);
										if(!it.stays_after_use) {
											player.remove(it);
										}
									} else if(m[3]) {
										let target = player.game.players[parseInt(m[3])];
										if(target) {
											it.use(target, player, player.game);
											if(!it.stays_after_use) {
												player.remove(it);
											}
										} else {
											msg.reply("Invalid target.");
										}
									} else {
										msg.reply("This item requires a target.");
									}
								} else {
									player.member.send(`You cannot use this item in the ${this.cur_state}.`);
								}
							}
						});
					})
					player.do_state(state, this);
				}
				this.day = 1;
				this.hiding_numbers = true;
				if(this.options.includes("daystart") || this.options.includes("nightless")) {
					return this.do_state(State.DAY);
				} else {
					return this.do_state(State.NIGHT);
				}
			case State.GAME_END:
				this.day_channel.permissionOverwrites.edit(this.day_channel.guild.roles.everyone, FULL_SEND_PERMS);
				this.day_channel.permissionOverwrites.edit(this.role_mafia_player, FULL_SEND_PERMS);
				this.mafia_secret_chat.permissionOverwrites.edit(this.role_mafia_player, NO_SEND_PERMS);
				for(let player of Object.values(this.players)) {
					this.mafia_secret_chat.permissionOverwrites.delete(player.member);
					player.member.roles.remove(this.role_mafia_player);
					player.item_collector.stop("game end");
					player.do_state(state, this);
				}
				break;
			case State.DAY: {
				this.hiding_numbers = false;
				this.day_channel.permissionOverwrites.edit(this.day_channel.guild.roles.everyone, NO_SEND_PERMS);
				this.day_channel.permissionOverwrites.edit(this.role_mafia_player, PARTIAL_SEND_PERMS);
				this.mafia_secret_chat.permissionOverwrites.edit(this.role_mafia_player, NO_SEND_PERMS);
				for(let player of Object.values(this.players)) {
					player.lynch_vote = null;
					if(!!player.inventory.items.find(x => !x.night_use)) {
						player.member.send(player.inventory.print(player, this));
					}
					player.do_state(state, this);
				}
				let numbers = "";
				for(let player of Object.values(this.players)) {
					numbers += `\n${player.number}- ${player.name}`;
				}
				this.day_channel.send(`<@&${this.role_mafia_player.id}> Day ${this.day} has begun. You have 10 minutes to vote on who to lynch with \`;lynch @usermention\`.${numbers}`);
				this.lunches = shuffle_array(foods).slice(0, 4);
				this.day_collector = this.day_channel.createMessageCollector();
				this.day_collector.on("collect", message => {
					let all_voted = true;
					for(let player of Object.values(this.players)) {
						if(player.member.id === message.author.id) {
							if(message.content.match(/^; *lynch$/)) {
								player.lynch_vote = 0;
								message.react(kaismile);
							} else if(message.content.match(/^; *removelynch$/)) {
								player.lynch_vote = null;
								message.react(kaismile);
							} else if(message.content.match(/^; *listlynch$/)) {
								message.reply(list_lynch(this.players));
							} else if(message.content.match(/^; *listlunch$/)) {
								message.reply(`Lunches available today are:\n${this.lunches.join(', ')}`);
							} else if(message.content.match(/^; *lunch$/)) {
								message.reply("Don't stay hungry.");
							} else if(message.content.match(/^; *lunch +<@!?([0-9]{17,18})>$/)) {
								message.reply("Interesting lunch choice.");
							} else if(message.content.match(/^; *lunch +(.+)$/)) {
								if(this.lunches.includes(message.content.match(/^; *lunch +(.+)$/)[1])) {
									message.reply("Good lunch choice.");
								} else {
									message.reply("Unavailable lunch choice.");
								}
							} else {
								let match = message.content.match(/^; *lynch +<@!?([0-9]{17,18})>$/);
								if(match) {
									for(let player2 of Object.values(this.players)) {
										if(player2.member.id === match[1]) {
											player.lynch_vote = player2.number;
											message.react(kaismile);
											break;
										}
									}
								}
							}
						}
						if(player.lynch_vote === null) {
							all_voted = false;
						}
					}
					if(all_voted) {
						if(this.timeout) {
							clearTimeout(this.timeout);
							this.timeout = null;
						}
						this.day_collector.stop("day end");
						this.day_collector = null;
						this.do_state(State.DAY_END);
					}
				});
				this.timeout = setTimeout(() => {
					this.day_channel.send("5min remaining.");
					this.timeout = setTimeout(() => {
						this.day_channel.send("2min30s remaining.");
						this.timeout = setTimeout(() => {
							this.day_channel.send("1min remaining.");
							this.timeout = setTimeout(() => {
								this.day_channel.send("10");
								this.timeout = setTimeout(() => {
									this.day_channel.send("9");
									this.timeout = setTimeout(() => {
										this.day_channel.send("8");
										this.timeout = setTimeout(() => {
											this.day_channel.send("7");
											this.timeout = setTimeout(() => {
												this.day_channel.send("6");
												this.timeout = setTimeout(() => {
													this.day_channel.send("5");
													this.timeout = setTimeout(() => {
														this.day_channel.send("4");
														this.timeout = setTimeout(() => {
															this.day_channel.send("3");
															this.timeout = setTimeout(() => {
																this.day_channel.send("2");
																this.timeout = setTimeout(() => {
																	this.day_channel.send("1");
																	this.timeout = setTimeout(() => {
																		this.timeout = null;
																		if(this.day_collector) {
																			this.day_collector.stop();
																			this.day_collector = null;
																		}
																		this.do_state(State.DAY_END);
																	}, 1000);
																}, 1000);
															}, 1000);
														}, 1000);
													}, 1000);
												}, 1000);
											}, 1000);
										}, 1000);
									}, 1000);
								}, 1000);
							}, 50000);
						}, 90000);
					}, 150000);
				}, 300000);
				break;
			}
			case State.DAY_END:
				this.day_channel.permissionOverwrites.edit(this.day_channel.guild.roles.everyone, NO_SEND_PERMS);
				this.day_channel.permissionOverwrites.edit(this.role_mafia_player, NO_SEND_PERMS);
				this.mafia_secret_chat.permissionOverwrites.edit(this.role_mafia_player, NO_SEND_PERMS);
				for(let player of Object.values(this.players)) {
					player.member
					player.do_state(state, this);
				}
				if(this.day_collector) {
					this.day_collector.stop("night end");
					this.day_collector = null;
				}
				if(this.timeout) {
					clearTimeout(this.timeout);
					this.timeout = null;
				}
				this.day++;
				if(this.options.includes("nightless")) {
					return this.do_state(State.DAY);
				} else {
					return this.do_state(State.NIGHT);
				}
			case State.NIGHT: {
				this.day_channel.permissionOverwrites.edit(this.day_channel.guild.roles.everyone, NO_SEND_PERMS);
				this.day_channel.permissionOverwrites.edit(this.role_mafia_player, NO_SEND_PERMS);
				this.mafia_secret_chat.permissionOverwrites.edit(this.role_mafia_player, PARTIAL_SEND_PERMS);
				if(this.timeout !== null) {
					clearTimeout(this.timeout);
					this.timeout = null;
				}
				this.kill_pending = true;
				this.night_report_passed = true;
				this.mafia_night_report_passed = true;
				let numbers = "";
				for(let p of Object.values(this.players)) {
					if(p.role.side !== Side.MAFIA) {
						numbers += "\n" + p.number + "- " + (this.hiding_numbers? "<hidden>": p.name);
					}
				}
				this.mafia_secret_chat.send(`<@&${this.role_mafia_player.id}> Night ${this.day} has begun. Use \`;kill <number>\` to kill someone, or just \`;kill\` to not kill tonight. The mafia can only do this once tonight, and you can't change your choice. Targets:${numbers}`);
				this.mafia_collector = this.mafia_secret_chat.createMessageCollector();
				this.mafia_collector.on("collect", msg => {
					let m = msg.content.match(/^; *kill +([0-9]+)$/);
					if(this.kill_pending && m) {
						let n = parseInt(m[1]);
						if(this.players.hasOwnProperty(n)) {
							if(this.players[n].role.side === Side.MAFIA) {
								msg.reply(`${m[1]}- ${this.players[n].name} is mafia-aligned.`);
							} else {
								this.kill_pending = false;
								this.killing = n;
								msg.reply(`You chose to kill number ${m[1]}, ${this.players[n].name}.`);
								this.mafia_collector.stop("kill chosen");
								this.mafia_collector = null;
								this.update_night();
							}
						} else {
							msg.reply(`${m[1]} is not a valid player.`);
						}
					} else if(this.kill_pending && msg.content.match(/^; *kill$/)) {
						this.kill_pending = false;
						this.killing = 0;
						msg.reply("You chose to kill nobody.");
						this.mafia_collector.stop("null kill chosen");
						this.mafia_collector = null;
						this.update_night();
					}
				});
				for(let player of Object.values(this.players)) {
					player.hooked = false;
					player.protected = false;
					player.action_pending = false;
					player.action_report_pending = false;
					if(!!player.inventory.items.find(x => x.night_use)) {
						player.member.send(player.inventory.print(player, this));
					}
					player.do_state(State.PRE_NIGHT, this);
				}
				this.day_channel.send(`<@&${this.role_mafia_player.id}> Night ${this.day} has begun. You have 7 minutes to act. If you are a power role, check your DMs. If you are mafia, check the mafia secret chat.`);
				for(let player of Object.values(this.players)) {
					player.do_state(state, this);
				}
				this.timeout = setTimeout(() => {
					this.timeout = null;
					if(this.day_collector) {
						this.day_collector.stop();
						this.day_collector = null;
					}
					this.do_state(State.NIGHT_END);
				}, 420000);
				this.update_night();
				break;
			}
			case State.NIGHT_END:
				this.day_channel.permissionOverwrites.edit(this.role_mafia_player, NO_SEND_PERMS);
				this.mafia_secret_chat.permissionOverwrites.edit(this.role_mafia_player, NO_SEND_PERMS);
				if(this.kill_pending) {
					this.mafia_secret_chat.send("The night ended. You killed no one.");
				} else if(this.killing && this.killing > 0) {
					let target = this.players[this.killing];
					if(!target.protected) {
						let d = death_messages[Math.floor(Math.random() * death_messages.length)];
						this.day_channel.send(d.replace(/%pr/g, `<@${target.member.id}> (${target.role.name})`));
					}
				}
				if(this.mafia_collector) {
					this.mafia_collector.stop("night end");
					this.mafia_collector = null;
				}
				if(this.timeout) {
					clearTimeout(this.timeout);
					this.timeout = null;
				}
				for(let player of Object.values(this.players)) {
					player.do_state(state, this);
				}
				if(this.options.includes("dayless")) {
					this.day++;
					return this.do_state(State.NIGHT);
				} else {
					return this.do_state(State.DAY);
				}
		}
	}
}