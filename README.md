### AuraDrop
Find my friends but real-time collaboration. Original idea based on building a better airdrop based on GPS proximity rather than bluetooth (because it fails so frequently). I often think about how find my friends could be even better, not just a map of location, but something that facilitates interaction and allows for serendipitous social iterations. Wanted to integrate real time proximity association.

Built on Cloudflare's Agent SDK and workers.

------------


KNOWN BUGS (REALLY IT JUST DOESN'T WORK YET LOL)
- [ ] Ok so adding a contact is irrelevant because it's getting proximity regardless lol
- [ ] Session starts but no text bubble pops up
- [ ] The mobile frontend looks pretty shit and functions pretty awfully

TODO
- [ ] Validate phone numbers w 2FA for yours
- [ ] Send an invite to the numbers you add rather than waiting for them to independently add you back
- [ ] Hover on added contacts expands and makes the UI janky
- [ ] The generated hash shows up when a phone number is long enough and it shakes the whole UI
- [ ] First notification doesn't disappear but subsequent ones do??
- [ ] Do I want a map??
- [ ] USE REACT FOR THE FRONT END TO MANAGE STATE THIS IS SO MESSY