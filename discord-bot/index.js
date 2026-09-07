'use strict'

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js')
const API = String(process.env.PERVENT_LICENSE_URL || 'http://127.0.0.1:38473').replace(/\/$/, '')
const TOKEN = process.env.DISCORD_BOT_TOKEN
const CLIENT_ID = process.env.DISCORD_CLIENT_ID
const GUILD_ID = process.env.DISCORD_GUILD_ID
const SECRET = process.env.PERVENT_ADMIN_SECRET
const LOG_CHANNEL_ID = process.env.DISCORD_LOG_CHANNEL_ID || ''
if (!TOKEN || !CLIENT_ID || !GUILD_ID || !SECRET) throw new Error('Set DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID and PERVENT_ADMIN_SECRET')

async function api(path, options = {}) {
  const r = await fetch(API + path, { ...options, headers: { 'Content-Type': 'application/json', 'x-admin-secret': SECRET, ...(options.headers || {}) } })
  const d = await r.json(); if (!r.ok) throw new Error(d.message || d.reason || `HTTP ${r.status}`); return d
}

const commands = [
  new SlashCommandBuilder().setName('key').setDescription('Manage Pervent licenses').addSubcommand(s => s.setName('create').setDescription('Create a license key').addStringOption(o => o.setName('duration').setDescription('30d, 7d, 1mo, 1y, lifetime').setRequired(true))).addSubcommand(s => s.setName('revoke').setDescription('Revoke a key').addStringOption(o => o.setName('key').setDescription('License key').setRequired(true))).addSubcommand(s => s.setName('ban').setDescription('Ban a key').addStringOption(o => o.setName('key').setDescription('License key').setRequired(true))),
  new SlashCommandBuilder().setName('hwid').setDescription('Manage HWID reset requests').addSubcommand(s => s.setName('pending').setDescription('List pending requests')).addSubcommand(s => s.setName('approve').setDescription('Approve request').addStringOption(o => o.setName('id').setDescription('Request ID').setRequired(true))).addSubcommand(s => s.setName('reject').setDescription('Reject request').addStringOption(o => o.setName('id').setDescription('Request ID').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false))),
  new SlashCommandBuilder().setName('licenses').setDescription('Show license summary')
].map(c => c.toJSON())

async function main() {
  const rest = new REST({ version: '10' }).setToken(TOKEN)
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands })
  const client = new Client({ intents: [GatewayIntentBits.Guilds] })
  const announced = new Set()
  client.once('ready', async () => {
    console.log(`Pervent bot online as ${client.user.tag}`)
    if (!LOG_CHANNEL_ID) return
    const poll = async () => {
      try {
        const d = await api('/admin/licenses')
        const channel = await client.channels.fetch(LOG_CHANNEL_ID)
        if (!channel || !channel.isTextBased()) return
        for (const q of d.resetRequests.filter(x => x.status === 'pending')) {
          if (announced.has(q.id)) continue
          announced.add(q.id)
          const embed = new EmbedBuilder().setTitle('Pervent • HWID Reset Request').setDescription(`**Request:** ${q.id}\n**License:** \`${q.key}\`\n**Reason:** ${q.reason}`).setColor(0x8b5cf6).setFooter({ text: 'Pervent Client • Review this request' })
          const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`hwid:approve:${q.id}`).setLabel('Approve').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`hwid:reject:${q.id}`).setLabel('Reject').setStyle(ButtonStyle.Danger))
          await channel.send({ embeds: [embed], components: [row] })
        }
      } catch (e) { console.error('HWID notification error:', e.message) }
    }
    await poll(); setInterval(poll, 10000)
  })
  client.on('interactionCreate', async i => {
    if (i.isButton()) {
      try {
        const [kind, action, id] = i.customId.split(':')
        if (kind !== 'hwid') return
        await api('/admin/hwid-reset', { method: 'POST', body: JSON.stringify({ id, action: action === 'approve' ? 'approve' : 'reject', reason: action === 'reject' ? `Rejected by ${i.user.tag}` : '' }) })
        return i.update({ content: `Request ${id} ${action}d by ${i.user.tag}.`, embeds: [], components: [] })
      } catch (e) { return i.reply({ ephemeral: true, content: `Error: ${e.message}` }) }
    }
    if (!i.isChatInputCommand()) return
    try {
      if (i.commandName === 'key') {
        const sub = i.options.getSubcommand(); const k = i.options.getString('key')
        if (sub === 'create') { const d = await api('/admin/key/create', { method: 'POST', body: JSON.stringify({ duration: i.options.getString('duration') }) }); return i.reply({ ephemeral: true, embeds: [new EmbedBuilder().setTitle('Pervent • License Created').setDescription(`\`${d.key}\`\nExpires: ${d.expiresAt || 'Lifetime'}`).setFooter({ text: 'Pervent Client' })] }) }
        await api('/admin/key/action', { method: 'POST', body: JSON.stringify({ key: k, action: sub }) }); return i.reply({ ephemeral: true, content: `Done — ${sub} applied to ${k}.` })
      }
      if (i.commandName === 'hwid') {
        const sub = i.options.getSubcommand(); const d = await api('/admin/licenses')
        if (sub === 'pending') { const q = d.resetRequests.filter(x => x.status === 'pending').slice(0, 10); return i.reply({ ephemeral: true, content: q.length ? q.map(x => `**${x.id}** • ${x.key}\n${x.reason}`).join('\n\n') : 'No pending HWID reset requests.' }) }
        const id = i.options.getString('id'); const action = sub === 'approve' ? 'approve' : 'reject'; await api('/admin/hwid-reset', { method: 'POST', body: JSON.stringify({ id, action, reason: i.options.getString('reason') || '' }) }); return i.reply({ ephemeral: true, content: `${id} ${action}d.` })
      }
      if (i.commandName === 'licenses') { const d = await api('/admin/licenses'); const active = d.keys.filter(x => !x.revoked && !x.banned && (!x.expiresAt || Date.parse(x.expiresAt) > Date.now())).length; return i.reply({ ephemeral: true, content: `**Pervent License Summary**\nTotal: ${d.keys.length}\nActive: ${active}\nPending HWID resets: ${d.resetRequests.filter(x => x.status === 'pending').length}` }) }
    } catch (e) { if (i.replied || i.deferred) i.editReply({ content: `Error: ${e.message}` }); else i.reply({ ephemeral: true, content: `Error: ${e.message}` }) }
  })
  await client.login(TOKEN)
}
main().catch(e => { console.error(e); process.exit(1) })
