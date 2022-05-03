import Discord from "discord.js";
import {Player, Game} from "./game";
import {items} from "./item";
import {shuffle_array, State} from "./util";

export type RoleAction = (player: Player, game: Game) => void;
export type RoleActionReport = (target: Player, player: Player, game: Game) => void;
export type RoleActionReportMsg = (msg: Discord.Message, target: Player, player: Player, game: Game) => void;

export enum Side {
	NONE,
	VILLAGE,
	MAFIA,
	THE_JOKER
}

export class Role {
	name: string;
	help: string;
	side: Side;
	fake_side?: Side = undefined;
	powerless?: boolean = false;
	/// if can cause its side to win even if they are at a loss, such as with guns
	/// this changes the win condition for the mafia from "mafia >= village" to "village == 0"
	/// the gun item also does this by itself, so this is false for deputy, who can lose their gun
	can_overturn?: boolean = false;
	/// if can't be saved
	macho?: boolean = false;
	actions: {[state: number]: RoleAction} = {};
}

function get_side(role: Role): Side {
	return role.fake_side === undefined || role.fake_side === null? role.side: role.fake_side;
}

function request_action_targeted(verb: string, report: RoleActionReport, player: Player, game: Game, dont_wait: boolean, max_shots: number) {
	player.data = {collector: null, target: null};
	let numbers = "";
	for(let p of Object.values(game.players)) {
		if(p.number != player.number) {
			numbers += "\n" + p.number + "- " + (game.hiding_numbers? "<hidden>": p.name);
		}
	}
	let left = max_shots !== -1? max_shots - player.data.shots_done: null;
	player.member.send((dont_wait?
		"Optionally, before anything else, select a player to " + verb + " tonight. Targets:":
		"Select a player to " + verb + " tonight, or ❌ to do nothing. Targets:") + numbers
		+ (left? ` You have ${left} use${left !== 1? "s": ""} of this action left.`: "")).then(msg => {
		for(let p of Object.values(game.players)) {
			if(p.number != player.number) {
				msg.react(p.number + "\u20E3");
			}
		}
		msg.react("❌");
		let collector = msg.createReactionCollector();
		player.data.collector = collector;
		collector.on("collect", (reaction, user) => {
			if(!user.bot) {
				if(reaction.emoji.name === "❌") {
                    msg.channel.send("Action cancelled.");
                    collector.stop();
					player.data.collector = null;
					player.data.target = null;
					player.action_pending = false;
					player.action_report_pending = true;
					game.update_night();
                } else if(parseInt(reaction.emoji.name.substring(0, 1)) !== NaN) {
					let n = parseInt(reaction.emoji.name.substring(0, 1));
					if(n === player.number) {
						player.member.send("You can't " + verb + " yourself.");
						return;
					}
					let p = game.players[n];
					if(p) {
						collector.stop();
						player.data.collector = null;
						player.action_pending = false;
						player.action_report_pending = true;
						msg.edit(msg.content + `\nYou chose to ${verb} ${p.name}.`);
						player.data.target = p;
						game.update_night();
					} else {
						player.member.send("Invalid target.");
					}
				}
			}
		});
	});
}

function request_action_targeted_mafia(verb: string, report: RoleActionReport, cancel_report: RoleAction | null, player: Player, game: Game, dont_wait: boolean, max_shots: number) {
	player.data.collector = null;
	player.data.target = null;
	let left = max_shots !== -1? max_shots - player.data.shots_done: null;
	game.mafia_secret_chat.send((dont_wait?
		"<@" + player.member.id + "> Optionally, before anything else, select a player to " + verb + " tonight with `;" + verb + " <number>`.":
		"<@" + player.member.id + "> Select a player to " + verb + " tonight with `;" + verb + " <number>`, or `;" + verb + "` to do nothing.")
		+ (left? ` You have ${left} use${left !== 1? "s": ""} of this action left.`: "")).then(msg => {
		let collector = game.mafia_secret_chat.createMessageCollector();
		player.data.collector = collector;
		collector.on("collect", action_msg => {
			if(!action_msg.member.user.bot && action_msg.member.id === player.member.id) {
				if(action_msg.content.match(new RegExp("^; *" + verb + "$", "i"))) {
                    action_msg.reply("Action cancelled.");
                    collector.stop();
					player.data.collector = null;
					player.data.target = null;
					player.action_pending = false;
					player.action_report_pending = false;
					if(cancel_report) cancel_report(player, game);
					game.update_night();
                } else {
					let m = action_msg.content.match(new RegExp("^; *" + verb + " +([0-9]+)$", "i"));
					if(m) {
						let n = parseInt(m[1]);
						let p = game.players[n];
						if(p) {
							collector.stop();
							player.data.collector = null;
							player.action_pending = false;
							player.action_report_pending = false;
							action_msg.reply(`You chose to ${verb} ${p.name}.`);
							report(p, player, game);
							player.data.shots_done++;
							if(max_shots !== -1 && player.data.shots_done >= max_shots) {
								game.mafia_secret_chat.send(`<@${player.member.id}> This was your last use of this action.`);
							}
							player.data.target = p;
							game.update_night();
						} else {
							action_msg.reply("Invalid target.");
						}
					}
				}
			}
		});
	});
}

/**
 * template for targeted actions
 * @param report callback to execute the action
 * @param hooked_report if hooked, calls this instead of report, or says "You were hooked." if this is true, or does nothing if null
 * @param cancel_report if the player cancelled the action, calls this instead of report
 * @param mafia this action will use commands in the mafia secret chat instead of reacts in DMs
 * @param dont_wait this action will not have a cancel and will not be waited for; usually for optional secondary actions
 * @param max_shots limit how many times the action can be done
 */
function template_targeted(verb: string, report: RoleActionReport, hooked_report?: RoleActionReport | boolean, cancel_report?: RoleAction, mafia: boolean = false, dont_wait: boolean = false, max_shots: number = -1): {[state: number]: RoleAction} {
	return {
		[State.NIGHT]: (player, game) => {
			if(!player.data.shots_done) player.data.shots_done = 0;
			if(max_shots !== -1 && player.data.shots_done >= max_shots) {
				return;
			}
			player.action_pending = !dont_wait;
			player.action_report_pending = dont_wait;
			if(mafia) {
				request_action_targeted_mafia(verb, report, cancel_report, player, game, dont_wait, max_shots);
			} else {
				request_action_targeted(verb, report, player, game, dont_wait, max_shots);
			}
		},
		[State.NIGHT_REPORT]: (player, game) => {
			if(!player.action_pending && player.action_report_pending) {
				player.action_report_pending = false;
				if(!player.data.target) {
					if(cancel_report) cancel_report(player, game);
				} else {
					if(player.hooked) {
						if(hooked_report === true) {
							if(mafia) {
								game.mafia_secret_chat.send(`<@${player.member.id}> You were hooked.`);
							} else {
								player.member.send("You were hooked.");
							}
						} else if(hooked_report) {
							hooked_report(player.data.target, player, game);
						}
					} else {
						report(player.data.target, player, game);
					}
					player.data.shots_done++;
					if(max_shots !== -1 && player.data.shots_done >= max_shots) {
						if(mafia) game.mafia_secret_chat.send(`<@${player.member.id}> This was your last use of this action.`);
						else player.member.send(`<@${player.member.id}> This was your last use of this action.`);
					}
				}
				game.update_night();
			}
		},
		[State.NIGHT_END]: (player, game) => {
			if(player.action_pending) {
				if(mafia) {
					if(!dont_wait) game.mafia_secret_chat.send(`<@${player.member.id}> The night is over. Action cancelled.`);
				} else {
					if(!dont_wait) player.member.send("The night is over. Action cancelled.");
				}
			}
			if(player.data.collector) {
				player.data.collector.stop("night end");
				player.data.collector = null;
			}
		}
	}
}

/**
 * template for actions that happen automatically and only need a report
 * @param report callback to execute the action
 * @param hooked_report if hooked, calls this instead of report, or says "You were hooked." if this is true, or does nothing if null
 */
function template_report(report: RoleAction, hooked_report?: RoleAction | boolean): {[state: number]: RoleAction} {
	return {
		[State.NIGHT]: (player, game) => {
			player.action_report_pending = true;
		},
		[State.NIGHT_REPORT]: (player, game) => {
			if(player.action_report_pending) {
				if(player.hooked) {
					if(hooked_report === true) {
						player.member.send("You were hooked.");
					} else if(hooked_report) {
						hooked_report(player, game);
					}
				} else {
					report(player, game);
				}
				player.action_report_pending = false;
				game.update_night();
			}
		}
	}
}

export let roles: {[name: string]: Role} = {
	Blue: {
		name: "Blue",
		help: "No powers.",
		side: Side.VILLAGE,
		powerless: true,
		actions: {}
	},
	Cop: {
		name: "Cop",
		help: "Every night, investigate a player to learn their side.",
		side: Side.VILLAGE,
		actions: template_targeted("investigate", (target, player, game) => {
			player.member.send(`${target.name} is sided with ${Side[get_side(target.role)]}.`);
		}, true)
	},
	MachoCop: {
		name: "MachoCop",
		help: "Every night, investigate a player to learn their side. You can't be protected, such as by docs.",
		side: Side.VILLAGE,
		macho: true,
		actions: template_targeted("investigate", (target, player, game) => {
			player.member.send(`${target.name} is sided with ${Side[get_side(target.role)]}.`);
		}, true)
	},
	TalentScout: {
		name: "TalentScout",
		help: "Every night, investigate a player to learn whether they have a talent.",
		side: Side.VILLAGE,
		actions: template_targeted("investigate", (target, player, game) => {
			player.member.send(`${target.name} ${target.role.powerless? "doesn't have": "has"} a talent.`);
		}, true)
	},
	Doc: {
		name: "Doc",
		help: "Every night, choose a player to prevent from dying that night.",
		side: Side.VILLAGE,
		actions: template_targeted("protect", (target, player, game) => {
			if(!target.role.macho) target.protected = true;
		})
	},
	MachoDoc: {
		name: "MachoDoc",
		help: "Every night, choose a player to prevent from dying that night. You can't be protected, such as by other docs.",
		side: Side.VILLAGE,
		macho: true,
		actions: template_targeted("protect", (target, player, game) => {
			if(!target.role.macho) target.protected = true;
		})
	},
	Bomb: {
		name: "Bomb",
		help: "If shot or killed at night, your attacker dies too.",
		side: Side.VILLAGE,
		actions: {[State.DEAD]: (player, game) => {
			if(player.killed_by instanceof Player && !player.killed_by.dead) {
				game.day_channel.send(`<@${player.killed_by.member.id}>, the ${player.killed_by.role.name}, exploded.`);
				game.kill(player.killed_by, player);
			}
		}}
	},
	Oracle: {
		name: "Oracle",
		help: "Every night, choose a player, and when you die, that player's role will be revealed.",
		side: Side.VILLAGE,
		actions: Object.assign(template_targeted("prophesy about", (target, player, game) => {
			player.data.oracle_target = target;
		}), {[State.DEAD]: (player: Player, game: Game) => {
			if(player.data.oracle_target) {
				game.day_channel.send(`Oracle's prophecy: ${player.data.oracle_target.name} is a ${player.data.oracle_target.role.name}.`);
			} else {
				game.day_channel.send(`Oracle's prophecy: none.`);
			}
		}})
	},
	Dreamer: {
		name: "Dreamer",
		help: "Every night, you receive a dream of either 1 innocent person, or 3 people, at least 1 of which is mafia-aligned.",
		side: Side.VILLAGE,
		actions: template_report((player, game) => {
			if(Math.random() < 0.5) {
				let vil: Player[] = Object.values(game.players).filter(x => get_side(x.role) === Side.VILLAGE && x.number !== player.number);
				player.member.send(vil[Math.floor(Math.random() * vil.length)] + " is sided with the VILLAGE.");
			} else {
				let list: Player[] = shuffle_array(Object.values(game.players));
				let maf = list.find(x => get_side(x.role) === Side.MAFIA);
				list = list.filter(x => x.number !== player.number && x.number !== maf.number).slice(0, 2);
				list.push(maf);
				player.member.send(shuffle_array(list).join(", ") + ". At least one of them is sided with the MAFIA.");
			}
		}, true)
	},
	Gunsmith: {
		name: "Gunsmith",
		help: "Every night, choose a player to give a gun to.",
		side: Side.VILLAGE,
		can_overturn: true,
		actions: template_targeted("give a gun to", (target, player, game) => {
			target.receive(items.Gun);
		})
	},
	Deputy: {
		name: "Deputy",
		help: "You start with a single gun that won't reveal that you shot it.",
		side: Side.VILLAGE,
		actions: {}
	},
	Vanilla: {
		name: "Vanilla",
		help: "No powers.",
		side: Side.MAFIA,
		powerless: true,
		actions: {}
	},
	Godfather: {
		name: "Godfather",
		help: "You appear as village-aligned to investigative roles.",
		side: Side.MAFIA,
		fake_side: Side.VILLAGE,
		actions: {}
	},
	Janitor: {
		name: "Janitor",
		help: "Once per game, at night, choose a player to clean, and their role will only be revealed to the mafia.\nThis replaces `;kill`, so don't use that when you want to clean.",
		side: Side.MAFIA,
		actions: template_targeted("clean", (target, player, game) => {
			if(game.kill_pending) {
				game.kill_pending = false;
				game.killing = -1;
				game.mafia_collector.stop("janitor cleaned");
				game.mafia_collector = null;
				game.day_channel.send(`<@${target.member.id}> is missing!`);
				game.mafia_secret_chat.send(`<@&${game.role_mafia_player.id}> While cleaning up the mess, you learned that ${target.name} is a ${target.role.name}.`);
				game.kill(target, player);
			}
		}, null, null, true, true, 1)
	},
	Hooker: {
		name: "Hooker",
		help: "Every night, choose a village-aligned player, and their action will be prevented that night.",
		side: Side.MAFIA,
		actions: Object.assign(template_targeted("hook", (target, player, game) => {
			target.hooked = true;
			game.night_report_passed = true;
		}, null, (player, game) => {
//			game.mafia_secret_chat.send("[debug] hooker action registered");
			game.night_report_passed = true;
		}, true), {[State.PRE_NIGHT]: (player: Player, game: Game) => {
			game.night_report_passed = false;
		}})
	}
};