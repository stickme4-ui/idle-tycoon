fx_version 'cerulean'
game 'gta5'
lua54 'yes'

name 'live_arena'
description 'TikTok Live Arena - gifts and likes spawn enemies (standalone, no framework)'
version '1.0.0'

shared_script 'config.lua'
client_script 'client.lua'
server_script 'server.lua'

-- Written by the Live Arena Node server on startup (contains its URL/port).
file 'server_url.txt'
