if ![ [ "$#" -eq 1 ] || [ "$#" -eq 2 ] ]; then
	echo "Usage: sh $0 <x> eventID" >&2
	echo "insert x before event ID to execute commands, otherwise dry run" >&2
	exit 1
fi
execute="n"
if [ $1 == "x" ]; then
	execute="y"
	shift
fi
re='^[0-9]+$'
if ! [[ $1 =~ $re ]] ; then
	echo "error: no event ID given" >&2
	echo "Usage: sh $0 <x> eventID" >&2
	echo "insert x before event ID to execute commands, otherwise dry run" >&2
	exit 1
fi
for server in $(heroku apps | awk "/zxzyz"$1"/ {print \$1}")
do
	echo "heroku git:remote -a "$server
	echo 'git push heroku master'
	if [ $execute == "y" ]; then
		heroku git:remote -a $server
		git push heroku master
	fi
done
