echo "Useage sh createVenue.sh <x> eventId 1 <level 2 servers> <level 3 servers> <level 4 servers>"
echo "eventId and the 1 after (for the number of venue servers) are obligatory. A letter x before them will execute the command, otherwise it will do a mock run."
execute="n"
if [ $1 == "x" ]; then
	execute="y"
	shift
fi
echo $execute
base="zxzyz"$1"-"
name=$base"10001"
echo "heroku apps:create "$name" --region eu"
echo "heroku git:remote -a "$name
echo 'heroku config:set servername="'$name'"'
echo 'heroku config:set group="backstage"'
echo "heroku pipelines:add audenceprod -a "$name" -s production"
if [ $execute == "y" ]; then
	heroku apps:create $name --region eu
	heroku git:remote -a $name
	heroku config:set servername="$name"
	heroku config:set group="backstage"
	heroku pipelines:add audenceprod -a "$name" -s production
fi

number=1
target=$3
start=20000
upstream=$name
while ((number <= target))
do
	((server = start + number))
	name=$base$server
	echo "heroku apps:create "$name" --region eu"
	echo "heroku git:remote -a "$name
	echo 'heroku config:set servername="'$name'"'
	echo 'heroku config:set upstream="'$upstream'"'
	echo 'git push heroku master'
	if [ $execute == "y" ]; then
		heroku apps:create $name --region eu
		heroku git:remote -a $name
		heroku config:set servername="$name"
		heroku config:set upstream="$upstream"
		git push heroku master
	fi
	((number = number + 1))
done
target=$4
start=30000
number=1
upstreamStart=20000
upstreamNumber=1
peerCount=0
maxPeers=20
while ((number <= target))
do
	if ((peerCount == maxPeers)); then
		peerCount=0
		((upstreamNumber = upstreamNumber +1))
	fi
	((upstream=upstreamStart+upstreamNumber))
	upstreamName=$base$upstream
	((server = start + number))
	name=$base$server
	((peerCount = peerCount + 1))
	echo "heroku apps:create "$name" --region eu"
	echo "heroku git:remote -a "$name
	echo 'heroku config:set servername="'$name'"'
	echo 'heroku config:set upstream="'$upstreamName'"'
	echo 'heroku config:set simulating="true"'
	echo 'git push heroku master'
	if [ $execute == "y" ]; then
		heroku apps:create "$name" --region eu
		heroku git:remote -a $name
		heroku config:set servername="$name"
		heroku config:set upstream="$upstreamName"
		git push heroku master
	fi
	((number = number + 1))
done
number=1
target=$5
start=40000
upstream=$name
while ((number <= target))
do
	echo "Level 4 needs to set upstream server correctly... build code first!!"
	((server = start + number))
	name=$base$server
	echo "heroku apps:create "$name" --region eu"
	echo "heroku git:remote -a "$name
	echo 'heroku config:set servername="'$name'"'
	echo 'heroku config:set upstream="'$upstream'"'
	echo 'git push heroku master'
	if [ $execute == "y" ]; then
		echo "heroku apps:create "$name" --region eu"
		echo "heroku git:remote -a "$name
		echo 'heroku config:set servername="'$name'"'
		echo 'heroku config:set upstream="'$upstream'"'
		echo 'git push heroku master'
	fi
	((number = number + 1))
done
	
