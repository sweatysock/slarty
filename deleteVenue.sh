echo "Useage sh deleteVenue.sh <x> eventId "
echo "eventId is obligatory. A letter x before this will execute the command, otherwise it will do a mock run."
execute="n"
if [ $1 == "x" ]; then
	execute="y"
	shift
fi
echo $execute

for server in $(heroku apps | awk "/zxzyz"$1"/ {print \$1}")
do
	echo "heroku apps:destroy "$server" --confirm "$server
	if [ $execute == "y" ]; then
		heroku apps:destroy $server --confirm $server
	fi
done

